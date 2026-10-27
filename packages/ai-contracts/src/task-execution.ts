import type {JsonValue, TaskRequest, TaskResult} from './data';
import type {AiExecution, EventPayload, ExecutionHealth, ExecutionHost, ExecutionState, Question} from './execution';
import {ContractError, isJsonValue, resolveMonitoring, validateOutputs} from './validation';

export const DEFAULT_AI_TIMEOUT_MS = 12 * 60 * 60 * 1000;

// Contract data is JSON; reconstruct in this realm (including VM/Jest consumers).
const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Services for a cooperative executor implementation. Cancellation settles after cleanup. */
export interface TaskOperationContext {
    signal: AbortSignal;

    emit(event: Exclude<EventPayload, { type: 'started' | 'terminal' | 'question' | 'answered' | 'health' }>): void;

    /** Associate a question with its tool call to pause only that tool's watchdog. */
    ask(question: Question, toolCallId?: string): Promise<JsonValue>;
}

/**
 * Run an accepted operation. Call assertCanStart before this helper and before side effects.
 * The operation must honor signal and finish cleanup before its promise settles.
 * Cancellation is a request to stop, not proof that earlier tool effects were rolled back.
 */
export function createTaskExecution(
    request: TaskRequest,
    host: ExecutionHost,
    operation: (context: TaskOperationContext) => Promise<TaskResult>,
): AiExecution {
    const monitoring = resolveMonitoring(host.monitoring);
    const task = copyJson(request);
    const attemptId = host.attemptId;
    const controller = new AbortController();
    const pending = new Map<string, {
        question: Question;
        toolCallId?: string;
        resolve(value: JsonValue): void;
        reject(error: Error): void
    }>();
    const asked = new Set<string>();
    const answered = new Set<string>();
    let state: ExecutionState = 'running';
    let sequence = 0;
    const startedAt = Date.now();
    let lastProgressAt = startedAt;
    let phaseAt = startedAt;
    let basePhase: 'starting' | 'model' | 'cleanup' = 'starting';
    let currentPhase: ExecutionHealth['phase'] = 'starting';
    const activeTools = new Map<string, { tool: string; startedAt: number; pausedAt?: number }>();
    let waitingMs = 0;
    let lastUsage: string | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stopReason: ExecutionHealth['stopReason'];
    const refreshPhase = () => {
        const phase: ExecutionHealth['phase'] = stopped ? 'stopping' : basePhase === 'cleanup' ? 'cleanup'
            : pending.size ? 'waiting_for_input' : activeTools.size ? 'tool' : basePhase;
        if (phase !== currentPhase) {
            if (currentPhase === 'waiting_for_input') waitingMs += Math.max(0, Date.now() - phaseAt);
            currentPhase = phase;
            phaseAt = Date.now();
        }
    };
    const health = (): ExecutionHealth => {
        const now = Date.now();
        const idleMs = Math.max(0, now - lastProgressAt);
        const phaseElapsedMs = Math.max(0, now - phaseAt);
        const waitingCalls = new Set([...pending.values()].map(entry => entry.toolCallId));
        const stalledTools = [...activeTools].filter(([callId, tool]) => !waitingCalls.has(callId) && now - tool.startedAt >= monitoring.stalledAfterMs)
            .map(([callId, tool]) => ({callId, tool: tool.tool, elapsedMs: Math.max(0, now - tool.startedAt)}));
        const activeMs = Math.max(0, now - startedAt - waitingMs - (currentPhase === 'waiting_for_input' ? phaseElapsedMs : 0));
        const condition = currentPhase === 'waiting_for_input' ? stalledTools.length ? 'stalled' : 'active'
            : currentPhase === 'stopping' || currentPhase === 'cleanup'
                ? phaseElapsedMs >= monitoring.stopGraceMs ? 'stalled' : 'active'
                : stalledTools.length || idleMs >= monitoring.stalledAfterMs ? 'stalled' : activeMs >= monitoring.slowAfterMs ? 'slow' : 'active';
        return {
            phase: currentPhase, condition, elapsedMs: Math.max(0, now - startedAt), idleMs,
            phaseElapsedMs, activeTools: activeTools.size, stalledTools, observedAt: new Date(now).toISOString(),
            heartbeatMs: monitoring.heartbeatMs, activeElapsedMs: activeMs,
            remainingMs: Math.max(0, budgetMs - activeMs),
            ...(pending.size ? {} : {deadlineAt: new Date(startedAt + budgetMs + waitingMs).toISOString()}),
            ...(stopReason ? {stopReason} : {})
        };
    };
    let stopped: TaskResult | undefined;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveResult!: (result: TaskResult) => void;
    const result = new Promise<TaskResult>(resolve => {
        resolveResult = resolve;
    });
    // deadlineAt sets the initial active-time budget, not a wall-clock limit on user replies.
    const budgetMs = host.deadlineAt === undefined ? DEFAULT_AI_TIMEOUT_MS : Date.parse(host.deadlineAt) - startedAt;
    const emit = (payload: EventPayload): void => {
        try {
            host.onEvent(copyJson({
                ...payload, taskId: task.taskId, attemptId,
                sequence: ++sequence, timestamp: new Date().toISOString()
            }));
        } catch { /* Observers cannot change authoritative state. */
        }
    };
    const stop = (outcome: TaskResult): void => {
        if (terminal || stopped) return;
        stopped = outcome;
        state = 'stopping';
        stopReason = outcome.status === 'cancelled' ? 'cancelled' : 'timeout';
        refreshPhase();
        emit({type: 'health', health: health()});
        controller.abort(outcome.status === 'cancelled' ? outcome.reason : 'Deadline exceeded');
        for (const entry of pending.values()) entry.reject(new Error('Execution stopped'));
        pending.clear();
    };
    const abort = (): void => {
        let reason = 'aborted';
        try {
            reason = String(host.signal.reason ?? reason);
        } catch { /* retain default */
        }
        stop({status: 'cancelled', reason});
    };
    const armDeadline = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (terminal || stopped || pending.size) return;
        const remaining = startedAt + budgetMs + waitingMs - Date.now();
        if (remaining <= 0) {
            stop({
                status: 'failed', error: {
                    code: 'timeout',
                    message: 'The AI execution time budget expired before completion was confirmed (time waiting for answers is excluded).',
                    retryable: false,
                    safeToReplay: false
                }
            });
        } else timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    const execution: AiExecution = {
        get state() {
            return state;
        },
        get health() {
            return terminal ? undefined : health();
        },
        result,
        async cancel(reason) {
            stop({status: 'cancelled', reason});
            await result;
        },
        async answer(id, value) {
            if (answered.has(id)) return 'duplicate';
            armDeadline();
            if (terminal || stopped) return 'closed';
            const entry = pending.get(id);
            if (!entry) return 'unknown_question';
            const question = entry.question;
            if (!isJsonValue(value) || (question.answer === 'text' && typeof value !== 'string') ||
                (question.optionsMode === 'exclusive' && !question.options?.some(option => option.value === value))) return 'invalid_answer';
            answered.add(id);
            pending.delete(id);
            const waitingTool = entry.toolCallId ? activeTools.get(entry.toolCallId) : undefined;
            if (waitingTool?.pausedAt !== undefined && ![...pending.values()].some(other => other.toolCallId === entry.toolCallId)) {
                waitingTool.startedAt += Math.max(0, Date.now() - waitingTool.pausedAt);
                waitingTool.pausedAt = undefined;
            }
            state = pending.size ? 'waiting_for_input' : 'running';
            lastProgressAt = Date.now();
            refreshPhase();
            armDeadline();
            entry.resolve(copyJson(value));
            emit({type: 'answered', questionId: id});
            emit({type: 'health', health: health()});
            return 'accepted';
        },
    };
    queueMicrotask(async () => {
        let outcome: TaskResult;
        host.signal.addEventListener('abort', abort, {once: true});
        if (host.signal.aborted) abort();
        armDeadline();
        try {
            if (stopped) outcome = stopped;
            else {
                emit({type: 'started'});
                const tick = () => {
                    if (terminal) return;
                    emit({type: 'health', health: health()});
                    if (!terminal) watchdog = setTimeout(tick, monitoring.heartbeatMs);
                };
                watchdog = setTimeout(tick, monitoring.heartbeatMs);
                controller.signal.throwIfAborted();
                outcome = await operation({
                    signal: controller.signal,
                    emit(event) {
                        if (terminal) return;
                        // Cleanup remains observable after cancellation. No new work is accepted then.
                        if (stopped && event.type !== 'phase' && event.type !== 'tool_finished') return;
                        if (event.type === 'phase') basePhase = event.phase;
                        if (event.type === 'tool_started' && !activeTools.has(event.callId)) activeTools.set(event.callId, {
                            tool: event.tool, startedAt: Date.now(),
                            ...([...pending.values()].some(q => q.toolCallId === event.callId) ? {pausedAt: Date.now()} : {})
                        });
                        if (event.type === 'tool_finished') activeTools.delete(event.callId);
                        if (event.type === 'usage') {
                            const usage = JSON.stringify(event.usage);
                            if (usage !== lastUsage) {
                                lastProgressAt = Date.now();
                                lastUsage = usage;
                            }
                        } else if (event.type !== 'phase') lastProgressAt = Date.now();
                        refreshPhase();
                        emit(event);
                    },
                    ask(question, toolCallId) {
                        armDeadline();
                        if (terminal || stopped) return Promise.reject(new Error('Execution stopped'));
                        if (!isJsonValue(question) || !question.id?.trim() || !question.prompt?.trim() ||
                            !['text', 'json'].includes(question.answer) || asked.has(question.id) ||
                            (question.optionsMode !== undefined && !['suggested', 'exclusive'].includes(question.optionsMode)) ||
                            (question.options !== undefined && (!Array.isArray(question.options) ||
                                !question.options.every(option => typeof option.label === 'string' && typeof option.value === 'string'))) ||
                            (question.optionsMode === 'exclusive' && !question.options?.length)) {
                            return Promise.reject(new Error('Invalid or duplicate question'));
                        }
                        asked.add(question.id);
                        const copy = copyJson(question);
                        const waitingTool = toolCallId ? activeTools.get(toolCallId) : undefined;
                        if (waitingTool && waitingTool.pausedAt === undefined) waitingTool.pausedAt = Date.now();
                        const answer = new Promise<JsonValue>((resolve, reject) => {
                            pending.set(copy.id, {question: copy, toolCallId, resolve, reject});
                        });
                        void answer.catch(() => { /* A misbehaving operation may fail to await its question. */
                        });
                        state = 'waiting_for_input';
                        lastProgressAt = Date.now();
                        refreshPhase();
                        armDeadline();
                        emit({type: 'question', question: copy});
                        emit({type: 'health', health: health()});
                        return answer;
                    },
                });
                armDeadline();
                if (!isJsonValue(outcome) || !outcome || typeof outcome !== 'object' ||
                    !['completed', 'failed', 'cancelled'].includes(outcome.status)) {
                    throw new Error('Operation returned an invalid terminal result');
                }
                if (outcome.status === 'completed') {
                    outcome = {...outcome, outputs: validateOutputs(task.output, outcome.outputs, task.outputShapes)};
                }
                // The operation must await all questions; silently dropping one loses user input.
                if (pending.size && !stopped) throw new Error('Operation ended with unanswered questions');
            }
        } catch (error) {
            outcome = {
                status: 'failed', error: error instanceof ContractError ? error.failure : {
                    code: 'executor_failed', message: error instanceof Error ? error.message : String(error),
                    retryable: false, safeToReplay: false,
                }
            };
        }
        terminal = true;
        if (watchdog !== undefined) clearTimeout(watchdog);
        if (timer !== undefined) clearTimeout(timer);
        host.signal.removeEventListener('abort', abort);
        for (const entry of pending.values()) entry.reject(new Error('Execution ended'));
        pending.clear();
        const final = copyJson(stopped ?? outcome);
        state = final.status;
        resolveResult(final);
        emit({type: 'terminal', result: final});
    });
    return execution;
}

import {
    type AiExecution,
    type AiTaskExecutor,
    assertCanStart,
    DEFAULT_AI_TIMEOUT_MS,
    type Capability,
    ContractError,
    type EventPayload,
    type ExecutionHost,
    type ExecutionState,
    type Failure,
    isJsonValue,
    type JsonValue,
    type Question,
    type TaskRequest,
    type TaskResult,
    validateOutputs,
} from '../../src';

export type Step =
    | { type: 'progress'; message: string }
    | { type: 'question'; question: Question }
    | { type: 'complete'; outputs: unknown }
    | { type: 'fail'; error: Failure };

/** Offline protocol fixture, deliberately excluded from the distributed package. */
export class ScriptedExecutor implements AiTaskExecutor {
    readonly id = 'test.scripted';
    readonly capabilities: readonly Capability[] = ['structured_output', 'questions'];

    constructor(private readonly script: readonly Step[]) {
    }

    async start(request: TaskRequest, host: ExecutionHost): Promise<AiExecution> {
        assertCanStart(request, host, this.id, this.capabilities);
        let state: ExecutionState = 'running';
        let sequence = 0;
        let cursor = 0;
        let pending: Question | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let advanceQueued = false;
        let deadline = host.deadlineAt === undefined ? Date.now() + DEFAULT_AI_TIMEOUT_MS : Date.parse(host.deadlineAt);
        let pausedAt = 0;
        const asked = new Set<string>();
        const answered = new Set<string>();
        let settle!: (outcome: TaskResult) => void;
        const result = new Promise<TaskResult>(resolve => {
            settle = resolve;
        });
        const closed = () => state === 'completed' || state === 'failed' || state === 'cancelled';
        const emit = (payload: EventPayload): void => {
            try {
                // Detach nested payloads so observer mutation cannot rewrite pending questions or results.
                host.onEvent(structuredClone({
                    ...payload,
                    taskId: request.taskId,
                    attemptId: host.attemptId,
                    sequence: ++sequence,
                    timestamp: new Date().toISOString()
                }));
            } catch { /* Observer exceptions do not alter the authoritative outcome. */
            }
        };
        const finish = (outcome: TaskResult): void => {
            if (closed()) return;
            state = outcome.status;
            pending = undefined;
            if (timer !== undefined) clearTimeout(timer);
            host.signal.removeEventListener('abort', abort);
            settle(outcome);
            emit({type: 'terminal', result: outcome});
        };
        const fail = (code: Failure['code'], message: string): void => {
            finish({status: 'failed', error: {code, message, retryable: false, safeToReplay: false}});
        };
        const abort = (): void => {
            let reason = 'aborted';
            try {
                reason = String(host.signal.reason ?? reason);
            } catch { /* Keep cancellation reliable. */
            }
            finish({status: 'cancelled', reason});
        };
        const expired = (): boolean => {
            if (pending || Date.now() < deadline) return false;
            fail('timeout', 'Deadline exceeded');
            return true;
        };
        const armDeadline = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            if (closed() || pending || expired()) return;
            // Re-arm long waits so native timer overflow cannot turn a future deadline into 1ms.
            timer = setTimeout(armDeadline, Math.min(deadline - Date.now(), 2_147_483_647));
        };
        const advance = (): void => {
            if (closed() || pending || expired()) return;
            try {
                while (!closed() && cursor < this.script.length) {
                    if (expired()) return;
                    const step = this.script[cursor++];
                    if (step.type === 'progress') {
                        emit(step);
                        continue;
                    }
                    if (step.type === 'fail') {
                        finish({status: 'failed', error: step.error});
                        return;
                    }
                    if (step.type === 'complete') {
                        finish({
                            status: 'completed',
                            outputs: validateOutputs(request.output, step.outputs),
                            artifacts: []
                        });
                        return;
                    }
                    if (asked.has(step.question.id)) {
                        fail('executor_failed', 'Duplicate question id');
                        return;
                    }
                    asked.add(step.question.id);
                    pending = step.question;
                    pausedAt = Date.now();
                    armDeadline();
                    state = 'waiting_for_input';
                    emit({type: 'question', question: pending});
                    return;
                }
                if (!closed()) fail('executor_failed', 'Script ended without a terminal result');
            } catch (error) {
                if (error instanceof ContractError) finish({status: 'failed', error: error.failure});
                else fail('executor_failed', error instanceof Error ? error.message : 'Script execution failed');
            }
        };
        const scheduleAdvance = (): void => {
            if (advanceQueued || closed()) return;
            advanceQueued = true;
            queueMicrotask(() => {
                advanceQueued = false;
                advance();
            });
        };

        const execution: AiExecution = {
            get state() {
                return state;
            },
            result,
            async answer(questionId: string, value: JsonValue) {
                // An already accepted id remains duplicate, even after the execution settles.
                if (answered.has(questionId)) return 'duplicate';
                if (closed() || expired()) return 'closed';
                if (!pending || pending.id !== questionId) return 'unknown_question';
                if (!isJsonValue(value) || (pending.answer === 'text' && typeof value !== 'string')) return 'invalid_answer';
                if (pending.optionsMode === 'exclusive' && !pending.options?.some(option => option.value === value)) return 'invalid_answer';
                answered.add(questionId);
                deadline += Math.max(0, Date.now() - pausedAt);
                pending = undefined;
                armDeadline();
                state = 'running';
                emit({type: 'answered', questionId});
                scheduleAdvance();
                return 'accepted';
            },
            async cancel(reason: string) {
                finish({status: 'cancelled', reason});
            },
        };

        queueMicrotask(() => {
            if (closed()) return;
            if (host.signal.aborted) {
                abort();
                return;
            }
            host.signal.addEventListener('abort', abort, {once: true});
            if (expired()) return;
            armDeadline();
            emit({type: 'started'});
            advance();
        });
        return execution;
    }
}

import {realpathSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
    type AiTaskExecutor,
    assertCanStart,
    type Capability,
    ContractError,
    createTaskExecution,
    DEFAULT_AI_TIMEOUT_MS,
    type ExecutionHost,
    isJsonValue,
    type JsonObject,
    type SessionRef,
    type TaskRequest,
    type TaskResult,
    type Usage,
    validateOutputs,
} from '@openhilo/ai-contracts';
import {CodexTransport, type Message} from './transport';

export interface CodexTaskExecutorOptions {
    id?: string;
    cliPath?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high';
    sandbox?: 'read-only' | 'workspace-write';
    /** An explicit alternate Codex home. Authentication remains owned by the CLI. */
    codexHome?: string;
    /** Per-attempt bound even when the host supplies no deadline. Excludes user-answer waits. Default twelve hours. */
    timeoutMs?: number;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: 'invalid_request' | 'invalid_output' | 'outcome_unknown', message: string, before = false): never => {
    throw new ContractError({code, message, retryable: false, safeToReplay: before});
};
const record = (v: unknown): v is JsonObject => Boolean(v && typeof v === 'object' && !Array.isArray(v) && isJsonValue(v));
const outputSchema = {
    type: 'object',
    properties: {
        resultJson: {
            type: 'string',
            description: 'A JSON-encoded object containing all declared task outputs.'
        }
    },
    required: ['resultJson'],
    additionalProperties: false
};
const askTool = {
    type: 'function',
    name: 'openhilo_ask_user',
    description: 'Ask the workflow user a question and wait for their answer. Use when clarification is needed.',
    inputSchema: {
        type: 'object',
        properties: {prompt: {type: 'string'}},
        required: ['prompt'],
        additionalProperties: false
    }
};

/** Codex CLI app-server v2 transport. Core never knows about processes or vendor configuration. */
export class CodexTaskExecutor implements AiTaskExecutor {
    readonly id: string;
    readonly capabilities: readonly Capability[] = ['structured_output', 'workspace', 'tools', 'questions', 'usage', 'continue'];
    private options: CodexTaskExecutorOptions;
    private busy = new Map<string, symbol>();

    constructor(options: CodexTaskExecutorOptions = {}) {
        for (const key of ['id', 'cliPath', 'model', 'codexHome'] as const) {
            const v = options[key];
            if (v !== undefined && (typeof v !== 'string' || !v.trim() || v.includes('\0'))) throw new Error(`Invalid Codex ${key}`);
        }
        if (options.sandbox !== undefined && !['read-only', 'workspace-write'].includes(options.sandbox)) throw new Error('Invalid Codex sandbox');
        if (options.effort !== undefined && !['low', 'medium', 'high'].includes(options.effort)) throw new Error('Invalid Codex effort');
        if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647)) throw new Error('Invalid Codex timeout');
        this.options = {...options};
        this.id = options.id ?? 'openhilo.codex';
    }

    async start(request: TaskRequest, host: ExecutionHost) {
        assertCanStart(request, host, this.id, this.capabilities);
        if (request.profile !== undefined) fail('invalid_request', 'Codex uses its configured model; task profiles are not supported', true);
        let cwd: string;
        try {
            cwd = realpathSync(fileURLToPath(host.workspace!.uri));
            if (!statSync(cwd).isDirectory()) throw new Error();
        } catch {
            return fail('invalid_request', 'Codex requires an existing local workspace directory', true);
        }
        const task = JSON.parse(JSON.stringify(request)) as TaskRequest;
        const definitions = JSON.parse(JSON.stringify(host.tools?.definitions ?? [])) as {
            name: string;
            description: string;
            inputSchema: JsonObject
        }[];
        // Bind saved threads to the registered tool namespace, even with a custom executor ID.
        const toolsHash = digest(definitions), configHash = digest({options: this.options, toolNamespace: 'openhilo'});
        let threadId: string | undefined, session: SessionRef | undefined;
        const reservation = Symbol('Codex attempt');
        const releaseReservation = () => {
            if (threadId && this.busy.get(threadId) === reservation) this.busy.delete(threadId);
        };
        let baseline = {inputTokens: 0, outputTokens: 0}, cumulative = {...baseline};
        if (task.continuation) {
            if (task.continuation.version !== 1) fail('invalid_request', 'Unsupported Codex session version', true);
            try {
                const saved = JSON.parse(task.continuation.opaqueId);
                if (!record(saved) || typeof saved.threadId !== 'string' || !saved.threadId || saved.cwd !== cwd || saved.toolsHash !== toolsHash || saved.configHash !== configHash)
                    throw new Error();
                threadId = saved.threadId;
                if (record(saved.tokens) && Number.isSafeInteger(saved.tokens.inputTokens) && Number.isSafeInteger(saved.tokens.outputTokens)
                    && (saved.tokens.inputTokens as number) >= 0 && (saved.tokens.outputTokens as number) >= 0) {
                    baseline = saved.tokens as typeof baseline;
                    cumulative = {...baseline};
                } else throw new Error();
            } catch {
                return fail('invalid_request', 'Codex session workspace, tools or configuration do not match', true);
            }
            if (this.busy.has(threadId)) fail('invalid_request', 'Codex session already has an active attempt', true);
            this.busy.set(threadId, reservation);
        }
        const deadlineAt = new Date(Math.min(Date.now() + (this.options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS), host.deadlineAt ? Date.parse(host.deadlineAt) : Infinity)).toISOString();
        const execution = createTaskExecution(task, {...host, deadlineAt}, async context => {
            let peer: CodexTransport | undefined, turnId: string | undefined, lastText: string | undefined,
                usage: Usage | undefined;
            let settled = false, questionIndex = 0;
            const seenCalls = new Set<string>(), pendingCalls = new Set<Promise<void>>();
            const nativeItems = new Map<string, { tool: string; finished: boolean }>();
            const streamedCommandItems = new Set<string>();
            const toolAbort = new AbortController(), toolSignal = AbortSignal.any([context.signal, toolAbort.signal]);
            const activeTools = new Set<Promise<unknown>>();
            let resolve!: (result: TaskResult) => void, reject!: (error: Error) => void;
            const result = new Promise<TaskResult>((yes, no) => {
                resolve = yes;
                reject = no;
            });
            void result.catch(() => {
            });
            const stop = (error: Error) => {
                if (!settled) {
                    settled = true;
                    toolAbort.abort(error);
                    reject(error);
                }
            };
            let abortTimer: NodeJS.Timeout | undefined;
            const abort = () => {
                stop(new Error('Codex attempt stopped'));
                // Bound cancellation even while initialize/thread/start/turn/start is awaiting a response.
                abortTimer = setTimeout(() => {
                    void peer?.close();
                }, 300);
            };
            context.signal.addEventListener('abort', abort, {once: true});
            const respond = (m: Message, value: unknown) => {
                if (!toolSignal.aborted) peer!.send({id: m.id, result: value});
            };
            const respondError = (m: Message, message: string) => {
                if (!toolSignal.aborted) peer!.send({id: m.id, error: {code: -32602, message}});
            };
            const scoped = (p: any) => p?.threadId === threadId && p?.turnId === turnId && typeof turnId === 'string';
            const serverRequest = async (m: Message) => {
                const p = m.params;
                if (!scoped(p)) {
                    respondError(m, 'Request does not belong to this attempt');
                    return;
                }
                if (m.method === 'item/tool/call') {
                    if (typeof p.callId !== 'string' || seenCalls.has(p.callId)) {
                        respondError(m, 'Duplicate or invalid tool call');
                        return;
                    }
                    seenCalls.add(p.callId);
                    if (p.namespace != null || !record(p.arguments)) {
                        respondError(m, 'Unsupported tool namespace or arguments');
                        return;
                    }
                    if (p.tool === 'openhilo_ask_user') {
                        if (typeof p.arguments.prompt !== 'string' || !p.arguments.prompt.trim()) {
                            respondError(m, 'Question prompt required');
                            return;
                        }
                        const answer = await context.ask({
                            id: `codex:${host.attemptId}:${++questionIndex}`,
                            prompt: p.arguments.prompt,
                            answer: 'text'
                        });
                        respond(m, {success: true, contentItems: [{type: 'inputText', text: JSON.stringify(answer)}]});
                        return;
                    }
                    const index = typeof p.tool === 'string' && /^openhilo_tool_\d+$/.test(p.tool) ? Number(p.tool.slice('openhilo_tool_'.length)) : -1;
                    const definition = definitions[index];
                    if (!definition || !host.tools) {
                        respondError(m, 'Unknown host tool');
                        return;
                    }
                    context.emit({type: 'tool_started', callId: p.callId, tool: definition.name});
                    let ok = false;
                    try {
                        const running = Promise.resolve(host.tools.invoke({
                            callId: p.callId,
                            name: definition.name,
                            arguments: p.arguments
                        }, toolSignal));
                        activeTools.add(running);
                        const output = await running.finally(() => activeTools.delete(running));
                        if (!isJsonValue(output as unknown)) throw new Error('Host tool returned a non-JSON result');
                        ok = output.ok;
                        if (!output.ok && output.error.safeToReplay !== true) {
                            stop(new ContractError({...output.error, retryable: false, safeToReplay: false}));
                            return;
                        }
                        respond(m, {
                            success: ok,
                            contentItems: [{
                                type: 'inputText',
                                text: JSON.stringify(output.ok ? output.output : output.error)
                            }]
                        });
                    } catch {
                        stop(new ContractError({
                            code: 'outcome_unknown',
                            message: 'Host tool failed; its effects could not be confirmed',
                            retryable: false,
                            safeToReplay: false
                        }));
                    } finally {
                        context.emit({
                            type: 'tool_finished',
                            callId: p.callId,
                            tool: definition.name,
                            outcome: ok ? 'completed' : 'failed'
                        });
                    }
                } else if (m.method === 'item/tool/requestUserInput') {
                    if (!Array.isArray(p.questions) || !p.questions.length) {
                        respondError(m, 'Invalid questions');
                        return;
                    }
                    const answers: [string, { answers: string[] }][] = [];
                    for (const q of p.questions) {
                        if (typeof q.id !== 'string' || typeof q.question !== 'string' || q.isSecret) {
                            respondError(m, 'Unsupported question');
                            return;
                        }
                        const answer = await context.ask({
                            id: `codex:${host.attemptId}:${++questionIndex}`, prompt: q.question, answer: 'text',
                            ...(Array.isArray(q.options) ? {
                                options: q.options.map((o: any) => ({
                                    label: o.label,
                                    value: o.label,
                                    reason: o.description
                                }))
                            } : {})
                        });
                        answers.push([q.id, {answers: [String(answer)]}]);
                    }
                    respond(m, {answers: Object.fromEntries(answers)});
                } else if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
                    respond(m, {decision: 'decline'});
                } else if (m.method === 'item/permissions/requestApproval') respond(m, {
                    permissions: {},
                    scope: 'turn'
                });
                else respondError(m, 'Unsupported Codex server request');
            };
            const receive = (m: Message) => {
                if (settled || context.signal.aborted) return;
                if (m.id !== undefined) {
                    const work = serverRequest(m).catch(error => stop(error)).finally(() => pendingCalls.delete(work));
                    pendingCalls.add(work);
                    return;
                }
                const p = m.params;
                if (!p || p.threadId !== threadId) return;
                if (m.method === 'thread/tokenUsage/updated') {
                    const u = p.tokenUsage?.total;
                    if (u && Number.isSafeInteger(u.inputTokens) && u.inputTokens >= 0 && Number.isSafeInteger(u.outputTokens) && u.outputTokens >= 0) {
                        if (!turnId && task.continuation) baseline = {
                            inputTokens: u.inputTokens,
                            outputTokens: u.outputTokens
                        };
                        if (scoped(p)) {
                            cumulative = {inputTokens: u.inputTokens, outputTokens: u.outputTokens};
                            if (u.inputTokens >= baseline.inputTokens && u.outputTokens >= baseline.outputTokens) {
                                usage = {
                                    inputTokens: u.inputTokens - baseline.inputTokens,
                                    outputTokens: u.outputTokens - baseline.outputTokens,
                                    measurement: 'reported'
                                };
                                context.emit({type: 'usage', usage});
                                if (session) session = {
                                    ...session,
                                    opaqueId: JSON.stringify({threadId, cwd, toolsHash, configHash, tokens: cumulative})
                                };
                            }
                        }
                    }
                }
                if (m.method === 'turn/started') {
                    if (typeof p.turn?.id !== 'string' || (turnId && turnId !== p.turn.id)) {
                        stop(new Error('Unexpected Codex turn identity'));
                        return;
                    }
                    turnId = p.turn.id;
                    return;
                }
                if (m.method === 'turn/completed') {
                    if (!turnId || p.turn?.id !== turnId) return;
                    if (pendingCalls.size) {
                        stop(new Error('Codex completed with pending host requests'));
                        return;
                    }
                    try {
                        if (p.turn.status === 'completed') {
                            const envelope = JSON.parse(lastText ?? 'null');
                            if (!record(envelope) || typeof envelope.resultJson !== 'string') fail('invalid_output', 'Codex did not return the structured task result');
                            const outputs = validateOutputs(task.output, JSON.parse(envelope.resultJson), task.outputShapes);
                            settled = true;
                            resolve({
                                status: 'completed',
                                outputs,
                                artifacts: [], ...(usage ? {usage} : {}), ...(session ? {session} : {})
                            });
                        } else {
                            const info = p.turn.error?.codexErrorInfo;
                            const code = info === 'usageLimitExceeded' ? 'quota_exhausted' : info === 'unauthorized' ? 'authentication_failed' : 'outcome_unknown';
                            const message = code === 'quota_exhausted'
                                ? 'Codex usage limit reached. Check your Codex allowance before starting another task.'
                                : code === 'authentication_failed'
                                    ? 'Codex authentication failed. Sign in to Codex CLI before starting another task.'
                                    : `Codex turn ${p.turn.status}${typeof p.turn.error?.message === 'string' ? `: ${p.turn.error.message}` : ''}`;
                            settled = true;
                            resolve({
                                status: 'failed',
                                error: {
                                    code,
                                    message,
                                    retryable: false,
                                    safeToReplay: false
                                }, ...(usage ? {usage} : {}), ...(session ? {session} : {})
                            });
                        }
                    } catch (error) {
                        stop(error instanceof ContractError ? error : new ContractError({
                            code: 'invalid_output',
                            message: 'Codex returned malformed structured output',
                            retryable: false,
                            safeToReplay: false
                        }));
                    }
                    return;
                }
                if (!scoped(p)) return;
                // Native Codex tools do not pass through item/tool/call. Their lifecycle
                // still matters to callers distinguishing model silence from tool work.
                if ((m.method === 'item/started' || m.method === 'item/completed') && typeof p.item?.id === 'string') {
                    const tool = ({
                        commandExecution: 'Codex command', fileChange: 'Codex file change',
                        mcpToolCall: 'Codex MCP tool', webSearch: 'Codex web search'
                    } as Record<string, string>)[p.item.type];
                    if (typeof tool === 'string' && m.method === 'item/started' && !nativeItems.has(p.item.id)) {
                        nativeItems.set(p.item.id, {tool, finished: false});
                        context.emit({type: 'tool_started', callId: `codex:item:${p.item.id}`, tool});
                    }
                    const active = nativeItems.get(p.item.id);
                    if (m.method === 'item/completed' && active && !active.finished) {
                        active.finished = true;
                        // Some Codex versions only attach command output to completion.
                        // When deltas were received, the aggregate is the same output.
                        if (p.item.type === 'commandExecution' && !streamedCommandItems.has(p.item.id) && typeof p.item.aggregatedOutput === 'string' && p.item.aggregatedOutput) {
                            context.emit({type: 'progress', message: p.item.aggregatedOutput});
                        }
                        const failed = ['failed', 'declined'].includes(p.item.status) || (typeof p.item.exitCode === 'number' && p.item.exitCode !== 0);
                        context.emit({
                            type: 'tool_finished',
                            callId: `codex:item:${p.item.id}`,
                            tool: active.tool,
                            outcome: failed ? 'failed' : 'completed'
                        });
                    }
                }
                if (m.method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary' && typeof p.item.text === 'string') lastText = p.item.text;
                if (m.method === 'item/commandExecution/outputDelta' && typeof p.itemId === 'string' && typeof p.delta === 'string' && p.delta) streamedCommandItems.add(p.itemId);
                if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(m.method ?? '') && typeof p.delta === 'string') context.emit({
                    type: 'progress',
                    message: p.delta
                });

            };
            try {
                context.signal.throwIfAborted();
                context.emit({type: 'phase', phase: 'starting'});
                peer = new CodexTransport(this.options.cliPath ?? 'codex', cwd, {
                    ...process.env, ...(this.options.codexHome ? {CODEX_HOME: this.options.codexHome} : {}),
                }, receive, error => stop(new ContractError({
                    code: 'outcome_unknown',
                    message: error.message,
                    retryable: false,
                    safeToReplay: false
                })));
                await peer.request('initialize', {
                    clientInfo: {name: 'openhilo', title: 'OpenHilo', version: '0.1.0'},
                    capabilities: {experimentalApi: true}
                });
                // Version metadata is advisory; validate actual protocol identities and outputs below.
                peer.send({method: 'initialized'});
                context.signal.throwIfAborted();
                const developerInstructions = [
                    'You execute an OpenHilo task supplied as JSON in the user message. Follow this mandatory response transport contract.',
                    'Return exactly one JSON object with a resultJson string containing the JSON-encoded task output object.',
                    `The declared output keys and their types are: ${JSON.stringify(task.output)}. Include every declared key with its declared type.`,
                    'When outputShapes is supplied, match every nested field and item type exactly; optional fields may be omitted. Do not rename fields or substitute objects for strings.',
                    'Never unwrap a single output, including a json output: its value must remain nested under its declared output key inside resultJson.',
                    'This transport contract takes precedence over any role instructions or examples requesting raw JSON or a different response format.',
                    'Use openhilo_ask_user for clarification. Do not claim completion until the work is done.',
                ].join('\n');
                const common = {
                    cwd,
                    approvalPolicy: 'never',
                    sandbox: this.options.sandbox ?? 'workspace-write',
                    developerInstructions,
                    ...(this.options.model ? {model: this.options.model} : {})
                };
                const loaded = await peer.request(threadId ? 'thread/resume' : 'thread/start', threadId ? {
                    ...common,
                    threadId,
                    excludeTurns: true
                } : {
                    ...common,
                    dynamicTools: [...definitions.map((d, i) => ({
                        type: 'function',
                        name: `openhilo_tool_${i}`,
                        description: `${d.name}: ${d.description}`,
                        inputSchema: d.inputSchema
                    })), askTool],
                });
                if (typeof loaded?.thread?.id !== 'string' || !loaded.thread.id || (threadId && loaded.thread.id !== threadId)) throw new Error('Codex returned an invalid thread identity');
                threadId = loaded.thread.id;
                this.busy.set(threadId!, reservation);
                session = {
                    executorId: this.id,
                    version: 1,
                    workspaceId: host.workspace!.id,
                    opaqueId: JSON.stringify({threadId, cwd, toolsHash, configHash, tokens: cumulative})
                };
                context.signal.throwIfAborted();
                context.emit({type: 'phase', phase: 'model'});
                const started = await peer.request('turn/start', {
                    threadId, input: [{
                        type: 'text', text: JSON.stringify({
                            instruction: task.instruction,
                            role: task.role,
                            constraints: task.constraints,
                            inputs: task.inputs,
                            context: task.context,
                            output: task.output,
                            ...(task.outputShapes ? {outputShapes: task.outputShapes} : {}),
                            budget: task.budget,
                            responseFormat: 'Return an object with resultJson, a string containing the JSON-encoded output object. Include every declared output with its declared type. Use openhilo_ask_user for clarification. Do not claim completion until the work is done.',
                        })
                    }], outputSchema, ...(this.options.effort ? {effort: this.options.effort} : {})
                });
                if (typeof started?.turn?.id !== 'string' || (turnId && turnId !== started.turn.id)) throw new Error('Codex returned an invalid turn identity');
                turnId = started.turn.id;
                return await result;
            } finally {
                context.emit({type: 'phase', phase: 'cleanup'});
                context.signal.removeEventListener('abort', abort);
                if (abortTimer) clearTimeout(abortTimer);
                if (context.signal.aborted && peer && threadId && turnId) {
                    try {
                        await peer.request('turn/interrupt', {threadId, turnId}, 300);
                    } catch { /* terminate below */
                    }
                }
                toolAbort.abort(new Error('Codex attempt ended'));
                // The model process must terminate even if a host tool ignores cancellation.
                // Keep the session reserved until every in-flight host effect has settled.
                await peer?.close();
                await Promise.allSettled([...activeTools]);
                releaseReservation();
            }
        });
        // Also release a reservation when an already-cancelled request never enters the operation.
        void execution.result.finally(releaseReservation);
        Object.defineProperty(execution, 'session', {get: () => session});
        return execution;
    }
}

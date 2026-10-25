import {randomUUID} from 'crypto';
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
    type Question,
    type SessionRef,
    type TaskRequest,
    type ToolDefinition,
    type ToolHost,
    type Usage,
    validateOutputs,
} from '@openhilo/ai-contracts';
import {createToolHost, type RegisteredTool} from '@openhilo/tool-host';
import {openAIConversation, type OpenAIProfile} from './openai';
import {anthropicConversation, type AnthropicProfile} from './anthropic';
import {clone, type ModelConversation, type ModelResult} from './model';
import {fail, modelFailure} from './errors';
import {localWorkspace} from './workspace';

export type ModelProfile = OpenAIProfile | AnthropicProfile;

export interface SdkExecutorOptions {
    /** Deployment identity, e.g. a versioned non-secret configuration fingerprint. */
    id?: string;
    profiles: Record<string, ModelProfile>;
    defaultProfile: string;
    /** Active execution budget excluding user-answer waits; defaults to twelve hours. */
    timeoutMs?: number;
    maxTurns?: number;
    maxToolCalls?: number;
    maxSessions?: number;
}

interface Session {
    conversation: ModelConversation;
    profile: string;
    workspaceId?: string;
    workspaceUri?: string;
    busy: boolean;
    seen: Set<string>
}

const reserved = new Set(['finish_task', 'ask_user', 'workspace_read', 'workspace_write', 'workspace_list']);
const questionSchema: JsonObject = {
    type: 'object', properties: {
        prompt: {type: 'string', minLength: 1},
        answer: {enum: ['text', 'json']},
        optionsMode: {enum: ['suggested', 'exclusive']},
        options: {
            type: 'array', items: {
                type: 'object', properties: {
                    label: {type: 'string'}, value: {type: 'string'},
                    recommended: {type: 'boolean'}, reason: {type: 'string'}
                }, required: ['label', 'value'], additionalProperties: false
            }
        },
    }, required: ['prompt', 'answer'], additionalProperties: false
};

/** One task loop, two native model adapters. Sessions are local context, not crash recovery. */
export class SdkTaskExecutor implements AiTaskExecutor {
    readonly id: string;
    readonly capabilities: readonly Capability[] = ['structured_output', 'tools', 'workspace', 'questions', 'continue', 'usage'];
    private sessions = new Map<string, Session>();
    private readonly options: SdkExecutorOptions;

    constructor(options: SdkExecutorOptions) {
        if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647)) fail('invalid_request', 'Invalid SDK timeout');
        if (options.id !== undefined && (typeof options.id !== 'string' || !options.id.trim() || options.id !== options.id.trim())) fail('invalid_request', 'SDK executor identity must be a nonempty trimmed string');
        this.id = options.id ?? 'openhilo.ai-sdk';
        this.options = {
            ...options,
            profiles: Object.fromEntries(Object.entries(options.profiles).map(([name, profile]) => [name, {...profile}]))
        };
        if (!Object.hasOwn(options.profiles, options.defaultProfile)) fail('invalid_request', 'Default SDK profile is missing');
        for (const profile of Object.values(options.profiles)) {
            if (!['openai', 'anthropic'].includes(profile.provider) || !profile.model?.trim() || !profile.client) fail('invalid_request', 'Invalid SDK profile');
            if (profile.maxOutputTokens !== undefined && (!Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0)) fail('invalid_request', 'Invalid output token limit');
        }
        for (const limit of [options.maxTurns, options.maxToolCalls, options.maxSessions]) {
            if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) fail('invalid_request', 'SDK limits must be positive integers');
        }
    }

    async start(request: TaskRequest, host: ExecutionHost) {
        assertCanStart(request, host, this.id, this.capabilities);
        const task = clone(request);
        if (!host.workspace && Object.values(task.output).some(kind => kind === 'file' || kind === 'dir')) return fail('invalid_request', 'File outputs require a workspace');
        const profileName = task.profile ?? this.options.defaultProfile;
        if (!Object.hasOwn(this.options.profiles, profileName)) return fail('invalid_request', `Unknown SDK profile: ${profileName}`);
        const profile = this.options.profiles[profileName];
        const suppliedDefinitions = clone(host.tools?.definitions ?? []);
        for (const tool of suppliedDefinitions) {
            if (reserved.has(tool.name) || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) return fail('invalid_request', `Invalid or reserved SDK tool name: ${tool.name}`);
        }
        const workspace = host.workspace ? await localWorkspace(host.workspace) : undefined;
        const sessionId = task.continuation?.opaqueId ?? randomUUID();
        let session = this.sessions.get(sessionId);
        if (task.continuation) {
            if (task.continuation.version !== 1 || !session) return fail('invalid_request', 'SDK context expired or belongs to another executor instance');
            if (session.busy) return fail('invalid_request', 'SDK context already has an active attempt');
            if (session.profile !== profileName || session.workspaceId !== host.workspace?.id || session.workspaceUri !== host.workspace?.uri)
                return fail('invalid_request', 'SDK continuation profile/workspace mismatch');
        } else {
            if (this.sessions.size >= (this.options.maxSessions ?? 128)) return fail('invalid_request', 'Release idle SDK sessions before starting more tasks');
            session = {
                conversation: profile.provider === 'openai' ? openAIConversation(profile) : anthropicConversation(profile),
                profile: profileName,
                workspaceId: host.workspace?.id,
                workspaceUri: host.workspace?.uri,
                busy: false,
                seen: new Set()
            };
            this.sessions.set(sessionId, session);
        }
        const current = session!;
        current.busy = true;
        const ref: SessionRef = {
            executorId: this.id,
            version: 1,
            opaqueId: sessionId, ...(host.workspace ? {workspaceId: host.workspace.id} : {})
        };
        const deadlineAt = new Date(Math.min(Date.now() + (this.options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS), host.deadlineAt ? Date.parse(host.deadlineAt) : Infinity)).toISOString();
        const execution = createTaskExecution(task, {...host, deadlineAt}, async context => {
            let effects = false;
            let usage: Usage | undefined;
            let allInputUsage = true;
            let allOutputUsage = true;
            try {
                const builtins: RegisteredTool[] = [...(workspace?.tools ?? []), {
                    name: 'ask_user',
                    description: 'Ask for clarification and wait for the answer. Options are suggestions unless explicitly exclusive.',
                    inputSchema: questionSchema,
                    readOnly: true,
                    async handler(args, {callId}) {
                        return context.ask({
                            ...args,
                            id: `${host.attemptId}:${callId}`
                        } as unknown as Question, callId.slice(host.attemptId.length + 1));
                    },
                }];
                const builtinHost = createToolHost(builtins);
                const finishDefinition: ToolDefinition = {
                    name: 'finish_task',
                    description: 'Complete the task with the declared output fields. Call alone after all other work.',
                    inputSchema: {
                        type: 'object',
                        properties: Object.fromEntries(Object.entries(task.output).map(([name, kind]) => [name,
                            kind === 'json' ? {} : {type: kind === 'text' || kind === 'file' || kind === 'dir' ? 'string' : kind}])) as JsonObject,
                        required: Object.keys(task.output),
                        additionalProperties: false
                    }
                };
                const definitions = [...suppliedDefinitions, ...builtinHost.definitions, finishDefinition];
                current.conversation.append(task);
                let callCount = 0;
                for (let turn = 0; turn < (this.options.maxTurns ?? 32); turn++) {
                    context.signal.throwIfAborted();
                    context.emit({type: 'phase', phase: 'model'});
                    const response = await current.conversation.next(definitions, context.signal);
                    context.signal.throwIfAborted();
                    allInputUsage &&= response.usage?.inputTokens !== undefined;
                    allOutputUsage &&= response.usage?.outputTokens !== undefined;
                    if (response.usage) {
                        const sample = response.usage;
                        if ([sample.inputTokens, sample.outputTokens].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return fail('invalid_output', 'Invalid SDK usage data');
                        context.emit({type: 'usage', usage: sample});
                        usage = {
                            measurement: 'reported',
                            ...(allInputUsage && sample.inputTokens !== undefined && (!usage || usage.inputTokens !== undefined) ? {inputTokens: (usage?.inputTokens ?? 0) + sample.inputTokens} : {}),
                            ...(allOutputUsage && sample.outputTokens !== undefined && (!usage || usage.outputTokens !== undefined) ? {outputTokens: (usage?.outputTokens ?? 0) + sample.outputTokens} : {})
                        };
                    }
                    if (!response.usage && usage) usage = {measurement: 'reported'};
                    if (!response.calls.length) return fail('invalid_output', 'Model ended without finish_task', !effects);
                    const batchIds = new Set<string>();
                    for (const call of response.calls) {
                        if (typeof call.id !== 'string' || !call.id.trim() || typeof call.name !== 'string' || !call.name.trim() || batchIds.has(call.id) || current.seen.has(call.id)) return fail('invalid_output', 'Duplicate or missing model tool call ID', !effects);
                        batchIds.add(call.id);
                        if (!isJsonValue(call.arguments) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) return fail('invalid_output', 'Tool arguments must be a JSON object', !effects);
                    }
                    if (callCount + response.calls.length > (this.options.maxToolCalls ?? 128)) return fail('executor_failed', 'SDK tool call limit reached', !effects);
                    callCount += response.calls.length;
                    if (response.calls.some(call => call.name === 'finish_task') && response.calls.length !== 1) return fail('invalid_output', 'finish_task must be called alone', !effects);
                    const results: ModelResult[] = [];
                    for (const call of response.calls) {
                        context.signal.throwIfAborted();
                        current.seen.add(call.id);
                        const args = clone(call.arguments) as JsonObject;
                        if (call.name === 'finish_task') {
                            const outputs = validateOutputs(task.output, args);
                            let artifacts;
                            try {
                                artifacts = workspace ? await workspace.artifacts(outputs, task.output) : [];
                            } catch {
                                return fail('invalid_output', 'Declared workspace output does not exist or is outside the workspace', false);
                            }
                            if (!workspace && Object.values(task.output).some(kind => kind === 'file' || kind === 'dir')) return fail('invalid_output', 'File outputs require a workspace', false);
                            current.conversation.submit([{id: call.id, result: {ok: true, output: {accepted: true}}}]);
                            return {status: 'completed', outputs, artifacts, session: ref, ...(usage ? {usage} : {})};
                        }
                        const builtin = builtins.some(tool => tool.name === call.name);
                        const toolHost: ToolHost | undefined = builtin ? builtinHost : suppliedDefinitions.some(tool => tool.name === call.name) ? host.tools : undefined;
                        context.emit({type: 'tool_started', callId: call.id, tool: call.name});
                        let result: Awaited<ReturnType<ToolHost['invoke']>>;
                        try {
                            if (toolHost && (!builtin || call.name === 'workspace_write')) effects = true;
                            result = toolHost ? await toolHost.invoke({
                                    callId: `${host.attemptId}:${call.id}`,
                                    name: call.name,
                                    arguments: args
                                }, context.signal)
                                : {
                                    ok: false,
                                    error: {
                                        code: 'invalid_request',
                                        message: `Unknown tool: ${call.name}`,
                                        retryable: false,
                                        safeToReplay: true
                                    }
                                };
                            if (!isJsonValue(result as unknown)) return fail('invalid_output', 'Tool returned non-JSON data', false);
                        } catch (error) {
                            context.emit({type: 'tool_finished', callId: call.id, tool: call.name, outcome: 'failed'});
                            throw error instanceof ContractError ? error : new ContractError({
                                code: 'outcome_unknown',
                                message: 'Tool host failed after invocation',
                                retryable: false,
                                safeToReplay: false
                            });
                        }
                        context.emit({
                            type: 'tool_finished',
                            callId: call.id,
                            tool: call.name,
                            outcome: result.ok ? 'completed' : 'failed'
                        });
                        if (!result.ok && !result.error.safeToReplay) throw new ContractError(result.error);
                        results.push({id: call.id, result});
                    }
                    current.conversation.submit(results);
                }
                return fail('executor_failed', 'SDK model turn limit reached', !effects);
            } catch (error) {
                return {status: 'failed', error: modelFailure(error, effects), ...(usage ? {usage} : {})};
            }
        });
        // Covers pre-aborted/deadline-expired handles for which the operation never runs.
        void execution.result.then(result => {
            current.busy = false;
            if (result.status !== 'completed') this.sessions.delete(sessionId);
        });
        Object.defineProperty(execution, 'session', {get: () => clone(ref)});
        return execution;
    }

    async releaseSession(ref: SessionRef): Promise<void> {
        if (ref.executorId !== this.id || ref.version !== 1) return fail('invalid_request', 'Wrong SDK session reference');
        const session = this.sessions.get(ref.opaqueId);
        if (session?.busy) return fail('invalid_request', 'Cannot release an active SDK task');
        this.sessions.delete(ref.opaqueId);
    }
}

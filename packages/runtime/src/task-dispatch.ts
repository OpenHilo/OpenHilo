import * as path from 'path';
import * as fs from 'fs/promises';
import {pathToFileURL} from 'url';
import {randomUUID} from 'crypto';
import {
    type AiExecution,
    type AiTaskExecutor,
    assertCanStart,
    ContractError,
    type ExecutionHost,
    type ExtensionState,
    isJsonValue,
    type TaskRequest,
    validateOutputs,
} from '@openhilo/ai-contracts';
import {type CFGNode, FailableError, type Value} from './types';
import {makeFileRef} from './file-reference';

export interface AiDispatchOptions {
    aiExecutor?: AiTaskExecutor;
    aiRoutingIdentity?: string;
    /** Application-supplied guidance, rendered before dispatch; core does not interpret it. */
    aiTaskInstructions?: readonly string[];
    /** Connects questions/events and supplies explicitly authorized tools or cancellation. */
    aiHost?: (request: TaskRequest) => Partial<ExecutionHost>;
    onAiExecution?: (execution: AiExecution, request: TaskRequest) => void;
}

/** Neutral path shared by injected providers and the legacy Claude composition. */
export async function dispatchAiTask(
    node: Extract<CFGNode, { type: 'call' }>, inputs: Record<string, Value>,
    options: AiDispatchOptions & { workdir: string; runId?: string }, executor: AiTaskExecutor,
    context?: ExtensionState[],
    onAiEvent?: ExecutionHost['onEvent'],
): Promise<{ outputs: Record<string, Value> }> {
    let accepted = false;
    try {
        if (options.runId && (executor.capabilities.includes('model_selection') || options.aiRoutingIdentity !== undefined) && options.aiRoutingIdentity !== executor.id) {
            throw new ContractError({code:'invalid_request',message:'AI routing configuration does not match the run',retryable:false,safeToReplay:true});
        }
        if (!isJsonValue(inputs)) throw new Error('AI task inputs must be JSON serializable');
        if (context !== undefined && !isJsonValue(context)) throw new Error('AI task context must be JSON serializable');
        // CLI skills have no portable meaning yet. Never silently drop a required skill on another provider.
        if (options.aiExecutor && node.skills?.length) {
            throw new ContractError({
                code: 'unsupported_capability',
                message: 'Declared CLI skills require a skill resource adapter',
                retryable: false,
                safeToReplay: true
            });
        }
        const constraints = [...(node.constraints ?? []), ...(options.aiTaskInstructions ?? [])];
        const request: TaskRequest = {
            version: 1, taskId: randomUUID(), instruction: node.intent ?? node.callee ?? 'Execute the task',
            inputs, output: node.outputs ?? {}, requiredCapabilities: ['structured_output', 'workspace'],
            ...(context?.length ? {context: JSON.parse(JSON.stringify(context)) as ExtensionState[]} : {}),
            ...(node.role ? {role: node.role} : {}),
            ...(constraints.length ? {constraints} : {}),
            ...(node.aiSelection !== undefined ? {aiSelection: node.aiSelection} : {}),
            ...(node.model ? {profile: node.model} : {}),
        };
        let execution: AiExecution | undefined;
        let unansweredQuestion = false;
        let attachmentFailed = false;
        let cancellation: Promise<void> | undefined;
        const stop = (reason: string) => {
            if (execution && !cancellation) cancellation = execution.cancel(reason).catch(() => {
                // The result remains authoritative even if cancellation delivery fails.
            });
        };
        const suppliedHost = options.aiHost?.(request);
        const host: ExecutionHost = {
            attemptId: randomUUID(), ...(options.runId ? {runId: options.runId} : {}), nodeId: node.id,
            workspace: {id: path.resolve(options.workdir), uri: pathToFileURL(path.resolve(options.workdir)).href},
            signal: new AbortController().signal,
            deadlineAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            ...suppliedHost,
            onEvent(event) {
                // A progress observer must not replace the unanswered-question guard.
                try {
                    onAiEvent?.(JSON.parse(JSON.stringify(event)));
                } catch { /* Telemetry cannot cause replay. */
                }
                try {
                    suppliedHost?.onEvent?.(event);
                } catch { /* Observers cannot cause replay. */
                }
                if (event.type === 'question' && !options.onAiExecution) {
                    unansweredQuestion = true;
                    stop('No runtime question handler is configured');
                }
            },
        };
        assertCanStart(request, host, executor.id, executor.capabilities);
        execution = await executor.start(request, host);
        accepted = true;
        if (unansweredQuestion) stop('No runtime question handler is configured');
        try {
            options.onAiExecution?.(execution, request);
        } catch {
            attachmentFailed = true;
            stop('Runtime question handler could not attach');
        }
        const result = await execution.result;
        try {
            if (attachmentFailed) throw new ContractError({
                code: 'executor_failed',
                message: 'Runtime question handler could not attach',
                retryable: false,
                safeToReplay: false
            });
            if (unansweredQuestion) throw new ContractError({
                code: 'unsupported_capability',
                message: 'No runtime question handler is configured',
                retryable: false,
                safeToReplay: false
            });
            if (result.status === 'failed') throw new ContractError(result.error);
            if (result.status === 'cancelled') throw new Error(`AI task cancelled: ${result.reason}`);
            const outputs: Record<string, Value> = validateOutputs(request.output, result.outputs);
            for (const [key, kind] of Object.entries(request.output)) {
                if (kind !== 'file' && kind !== 'dir') continue;
                const resolved = path.resolve(options.workdir, outputs[key] as string);
                const relative = path.relative(path.resolve(options.workdir), resolved);
                if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`AI output ${key} must be within the workspace`);
                const realWorkspace = await fs.realpath(options.workdir);
                const realOutput = await fs.realpath(resolved);
                const realRelative = path.relative(realWorkspace, realOutput);
                if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`AI output ${key} resolves outside the workspace`);
                const stat = await fs.stat(resolved);
                if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error(`AI output ${key} must be ${kind}`);
                outputs[key] = await makeFileRef(resolved, options.workdir, key);
            }
            return {outputs};
        } finally {
            if (result.session) await executor.releaseSession?.(result.session);
        }
    } catch (error) {
        throw new FailableError(error instanceof Error ? error.message : String(error),
            error instanceof ContractError ? error.failure : accepted ? {
                code: 'outcome_unknown',
                message: 'Accepted AI attempt ended without a confirmed usable result',
                retryable: false,
                safeToReplay: false
            } : undefined);
    }
}

import type {ExecutorFn} from './execution-engine';
import {type AiDispatchOptions, dispatchAiTask} from './task-dispatch';

export interface DispatcherOptions extends AiDispatchOptions {
    workdir: string;
    runId?: string;
    codeExecutor?: ExecutorFn;
    sysExecutor?: ExecutorFn;
}

/** Pure composition of explicitly supplied leaf executors. No provider/process defaults. */
export function createDispatcher(options: DispatcherOptions): ExecutorFn {
    return async (node, inputs, context) => {
        if (node.type !== 'call') throw new Error(`Dispatcher: expected call node, got "${node.type}"`);
        if (node.executor === 'human') throw new Error('Dispatcher: human executor is handled by ExecutionEngine, not dispatcher');
        if (node.executor === 'intent') throw new Error(`Dispatcher: executor 'intent' must be intercepted by path-one; callee '${node.callee}' not found in snapshot`);
        if (node.executor === 'sys') {
            if (node.callee === 'getWorkdir') return {outputs: {path: options.workdir}};
            if (!options.sysExecutor) throw new Error('Dispatcher: sysExecutor not configured for this run');
            return options.sysExecutor(node, inputs, context);
        }
        if (node.executor === 'code') {
            if (!options.codeExecutor) throw new Error('Dispatcher: codeExecutor not configured for this run');
            return options.codeExecutor(node, inputs, context);
        }
        if (node.executor === 'ai') {
            if (!options.aiExecutor) throw new Error('Dispatcher: aiExecutor not configured for this run');
            return dispatchAiTask(node, inputs, options, options.aiExecutor, context?.extensions, context?.onAiEvent);
        }
        throw new Error(`Dispatcher: unknown executor type "${node.executor}"`);
    };
}

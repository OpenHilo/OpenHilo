import {createDispatcher} from '@openhilo/runtime/dispatcher';
import {createCodeExecutor, executePython, CodeProcessError, type CodeExecutionOptions} from '@openhilo/code-local';
import type {RunResources} from '@openhilo/runtime/run-service';

export const resources: RunResources = {
    executor: createDispatcher({
        runId: 'run',
        workdir: '.',
        codeExecutor: createCodeExecutor('.', {timeoutMs: 1000, maxOutputBytes: 1024, maxResultBytes: 1024,
            signal: new AbortController().signal, killGraceMs: 20})
    })
};

export const limits: CodeExecutionOptions = {maxOutputBytes: Infinity, timeoutMs: 1000};
export const python = () => executePython({script: '', inputs: {}, declaredOutputs: {}, workingDir: '.', workspaceDir: '.', ...limits});
export const failureReason = (error: unknown) => error instanceof CodeProcessError ? error.reason : undefined;

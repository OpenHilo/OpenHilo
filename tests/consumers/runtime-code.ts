import {createDispatcher} from '@openhilo/runtime/dispatcher';
import {createCodeExecutor} from '@openhilo/code-local';
import type {RunResources} from '@openhilo/runtime/run-service';

export const resources: RunResources = {
    executor: createDispatcher({
        runId: 'run',
        workdir: '.',
        codeExecutor: createCodeExecutor('.')
    })
};

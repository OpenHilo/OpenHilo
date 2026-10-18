import {TerminalHumanExecutor} from '@openhilo/human-terminal';
import type {HumanExecutor} from '@openhilo/human-contracts';
import type {ResumeRunOpts, StartRunOpts} from '@openhilo/runtime/run-service';

export const human: HumanExecutor = new TerminalHumanExecutor({
    promptFn: async (_prompt, _signal) => '1',
    write: _text => {
    }
});
export const attach = (options: StartRunOpts): ResumeRunOpts => ({
    runDir: 'run',
    createResources: options.createResources,
    humanExecutor: human
});

import OpenAI from 'openai';
import {SdkTaskExecutor} from '@openhilo/ai-sdk';
import {createToolHost} from '@openhilo/tool-host';
import type {AiTaskExecutor} from '@openhilo/ai-contracts';

export const executor: AiTaskExecutor = new SdkTaskExecutor({
    profiles: {
        openai: {
            provider: 'openai',
            model: 'explicit-model',
            client: new OpenAI({apiKey: 'fixture-only'})
        }
    }, defaultProfile: 'openai'
});
export const tools = createToolHost([{
    name: 'lookup',
    description: 'read one',
    inputSchema: {type: 'object'},
    readOnly: true,
    handler: async () => ({found: true})
}]);

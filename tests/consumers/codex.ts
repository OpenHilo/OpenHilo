import {CodexTaskExecutor} from '@openhilo/ai-codex';
import type {AiTaskExecutor} from '@openhilo/ai-contracts';

export const executor: AiTaskExecutor = new CodexTaskExecutor({sandbox: 'read-only', timeoutMs: 5000});

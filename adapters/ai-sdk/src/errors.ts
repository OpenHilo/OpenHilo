import {ContractError, type Failure} from '@openhilo/ai-contracts';
import {APIConnectionTimeoutError as OpenAITimeoutError} from 'openai';
import {APIConnectionTimeoutError as AnthropicTimeoutError} from '@anthropic-ai/sdk';

export const fail = (code: Failure['code'], message: string, safeToReplay = true): never => {
    throw new ContractError({code, message, retryable: false, safeToReplay});
};

export function modelFailure(error: unknown, effects: boolean): Failure {
    if (error instanceof ContractError) return {...error.failure, safeToReplay: !effects && error.failure.safeToReplay};
    const item = error as {
        status?: number;
        name?: string;
        code?: string;
        type?: string;
        error?: { code?: string; error?: { code?: string; type?: string } }
    } | undefined;
    const status = item?.status;
    const code = item?.code ?? item?.error?.code ?? item?.error?.error?.code ?? item?.type ?? item?.error?.error?.type;
    const timedOut = error instanceof OpenAITimeoutError || error instanceof AnthropicTimeoutError || item?.name?.includes('Timeout');
    const category = status === 401 || status === 403 ? 'authentication_failed'
        : code === 'insufficient_quota' || code === 'billing_error' ? 'quota_exhausted'
            : status === 429 ? 'rate_limited' : timedOut ? 'timeout' : 'executor_failed';
    // Do not copy SDK request bodies, headers or credentials into public failures.
    return {
        code: category,
        message: `SDK model request failed${status ? ` (HTTP ${status})` : ''}`,
        retryable: category === 'rate_limited' || category === 'timeout' || (status !== undefined && status >= 500),
        safeToReplay: !effects
    };
}

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {type ModelProfile, SdkTaskExecutor} from './executor';

export interface SdkConnection {
    provider: 'openai' | 'anthropic';
    model: string;
    apiKey: string;
    baseURL?: string;
    maxOutputTokens?: number;
}

/** Explicit credentials/endpoints; SDK environment defaults and HTTP retries are disabled. No I/O at construction. */
export function createSdkTaskExecutor(profiles: Record<string, SdkConnection>, defaultProfile: string, options: {
    id?: string
} = {}): SdkTaskExecutor {
    const connected = Object.fromEntries(Object.entries(profiles).map(([name, profile]): [string, ModelProfile] => {
        if (!profile.apiKey?.trim()) throw new Error('SDK credentials must be supplied explicitly');
        const common = {model: profile.model, maxOutputTokens: profile.maxOutputTokens};
        if (profile.provider === 'openai') return [name, {
            ...common, provider: 'openai', client: new OpenAI({
                apiKey: profile.apiKey,
                baseURL: profile.baseURL ?? 'https://api.openai.com/v1',
                maxRetries: 0,
                organization: null,
                project: null
            }),
        }];
        if (profile.provider === 'anthropic') return [name, {
            ...common, provider: 'anthropic', client: new Anthropic({
                apiKey: profile.apiKey, authToken: null,
                baseURL: profile.baseURL ?? 'https://api.anthropic.com', maxRetries: 0
            }),
        }];
        throw new Error('Unsupported SDK provider');
    }));
    return new SdkTaskExecutor({profiles: connected, defaultProfile, id: options.id});
}

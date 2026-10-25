import {AI_TYPES, AI_LEVELS, type AiType, type AiLevel} from '@openhilo/itt-contracts/ai-selection';
/** Serializable application composition. Credentials remain in the host environment. */
export interface SdkProfileConfig {
    provider: 'openai' | 'anthropic';
    model: string;
    api_key_env: string;
    base_url?: string;
    max_output_tokens?: number;
}

export interface CodexExecutionConfig {
    adapter: 'codex';
    cli_path?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high';
    sandbox?: 'read-only' | 'workspace-write';
    codex_home?: string;
    timeout_ms?: number;
}

/** Configuration only: claude-code is an external-application compatibility selection.
 * OpenHilo core supplies no Claude Code executor; the embedding host must resolve availability.
 */
export interface RoutedExecutionConfig {
    adapter: 'routed';
    routes: Partial<Record<AiType, {defaultLevel: AiLevel; levels: Partial<Record<AiLevel, DirectAiExecutionConfig>>}>>;
}
export type AiExecutionConfig = {adapter: 'claude-code'} | DirectAiExecutionConfig | RoutedExecutionConfig;
export type DirectAiExecutionConfig = CodexExecutionConfig | {
    adapter: 'sdk';
    timeout_ms?: number;
    default_profile: string;
    profiles: Record<string, SdkProfileConfig>;
};

export class AiExecutionConfigError extends Error {
    constructor(message: string) {
        super(`ai_execution: ${message}`);
        this.name = 'AiExecutionConfigError';
    }
}

function object(value: unknown, at: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiExecutionConfigError(`${at} must be an object`);
    return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: string[], at: string): void {
    // Do not echo unknown fields or values: these can contain mistakenly pasted credentials.
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new AiExecutionConfigError(`${at} contains unsupported fields`);
}

function nonempty(value: unknown, at: string): string {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new AiExecutionConfigError(`${at} must be a nonempty, trimmed string`);
    return value;
}

/** Absent configuration returns undefined without choosing a provider. Explicit selections are
 * validated as data only; the host supplies implementations. Invalid selections never imply fallback.
 */
export function parseAiExecutionConfig(value: unknown): AiExecutionConfig | undefined {
    if (value === undefined) return undefined;
    const root = object(value, 'configuration');
    if (root.adapter === 'routed') {
        fields(root, ['adapter', 'routes'], 'routing configuration');
        const routes = object(root.routes, 'routes');
        fields(routes, [...AI_TYPES], 'routes');
        if (!Object.hasOwn(routes, 'default')) throw new AiExecutionConfigError('routes.default is required');
        const entries = Object.entries(routes).map(([type, raw]) => {
            const group = object(raw, `routes.${type}`);
            fields(group, ['defaultLevel', 'levels'], `routes.${type}`);
            if (!(AI_LEVELS as readonly unknown[]).includes(group.defaultLevel)) throw new AiExecutionConfigError(`invalid defaultLevel for ${type}`);
            const levels = object(group.levels, `routes.${type}.levels`);
            fields(levels, [...AI_LEVELS], `routes.${type}.levels`);
            if (!Object.hasOwn(levels, group.defaultLevel as string)) throw new AiExecutionConfigError(`defaultLevel must reference a configured level for ${type}`);
            const cells = Object.entries(levels).map(([level, value]) => {
                const cell = object(value, `routes.${type}.${level}`);
                if (!['codex', 'sdk'].includes(cell.adapter as string)) throw new AiExecutionConfigError(`routes.${type}.${level} requires a direct codex or sdk configuration`);
                return [level, parseAiExecutionConfig(cell)];
            });
            return [type, {defaultLevel: group.defaultLevel, levels: Object.fromEntries(cells)}];
        });
        return {adapter: 'routed', routes: Object.fromEntries(entries)};
    }
    if (root.adapter === 'claude-code') {
        fields(root, ['adapter'], 'Claude configuration');
        return {adapter: 'claude-code'};
    }
    if (root.adapter === 'codex') {
        fields(root, ['adapter', 'cli_path', 'model', 'effort', 'sandbox', 'codex_home', 'timeout_ms'], 'Codex configuration');
        const result: CodexExecutionConfig = {adapter: 'codex'};
        for (const key of ['cli_path', 'model', 'codex_home'] as const) if (root[key] !== undefined) {
            const value = nonempty(root[key], key);
            if (value.includes('\0')) throw new AiExecutionConfigError(`${key} contains a null character`);
            result[key] = value;
        }
        if (root.effort !== undefined) {
            if (!['low', 'medium', 'high'].includes(root.effort as string)) throw new AiExecutionConfigError('invalid Codex effort');
            result.effort = root.effort as CodexExecutionConfig['effort'];
        }
        if (root.sandbox !== undefined) {
            if (!['read-only', 'workspace-write'].includes(root.sandbox as string)) throw new AiExecutionConfigError('invalid Codex sandbox');
            result.sandbox = root.sandbox as CodexExecutionConfig['sandbox'];
        }
        if (root.timeout_ms !== undefined) {
            if (!Number.isSafeInteger(root.timeout_ms) || (root.timeout_ms as number) < 1 || (root.timeout_ms as number) > 2147483647) throw new AiExecutionConfigError('invalid Codex timeout_ms');
            result.timeout_ms = root.timeout_ms as number;
        }
        return result;
    }
    if (root.adapter !== 'sdk') throw new AiExecutionConfigError('adapter must be routed, sdk, codex or claude-code');
    fields(root, ['adapter', 'default_profile', 'profiles', 'timeout_ms'], 'SDK configuration');
    if (root.timeout_ms !== undefined && (!Number.isSafeInteger(root.timeout_ms) || (root.timeout_ms as number) < 1 || (root.timeout_ms as number) > 2147483647)) throw new AiExecutionConfigError('invalid SDK timeout_ms');
    const defaultProfile = nonempty(root.default_profile, 'default_profile');
    const source = object(root.profiles, 'profiles');
    const entries = Object.entries(source).map(([name, raw]): [string, SdkProfileConfig] => {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name))
            throw new AiExecutionConfigError('profile names must be 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit');
        const profile = object(raw, 'profile');
        fields(profile, ['provider', 'model', 'api_key_env', 'base_url', 'max_output_tokens'], 'profile');
        if (profile.provider !== 'openai' && profile.provider !== 'anthropic') throw new AiExecutionConfigError('profile provider must be openai or anthropic');
        const model = nonempty(profile.model, 'model');
        const api_key_env = nonempty(profile.api_key_env, 'api_key_env');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(api_key_env)) throw new AiExecutionConfigError('api_key_env must name an environment variable');
        const result: SdkProfileConfig = {provider: profile.provider, model, api_key_env};
        if (profile.base_url !== undefined) {
            const url = nonempty(profile.base_url, 'base_url');
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                throw new AiExecutionConfigError('base_url must be an absolute HTTP(S) URL');
            }
            if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
                throw new AiExecutionConfigError('base_url must be HTTP(S), without credentials, query or fragment');
            result.base_url = url;
        }
        if (profile.max_output_tokens !== undefined) {
            if (!Number.isSafeInteger(profile.max_output_tokens) || (profile.max_output_tokens as number) < 1)
                throw new AiExecutionConfigError('max_output_tokens must be a positive integer');
            result.max_output_tokens = profile.max_output_tokens as number;
        }
        return [name, result];
    });
    if (!Object.prototype.hasOwnProperty.call(source, defaultProfile)) throw new AiExecutionConfigError('default_profile must reference a configured profile');
    return {adapter: 'sdk', default_profile: defaultProfile, profiles: Object.fromEntries(entries), ...(root.timeout_ms !== undefined ? {timeout_ms: root.timeout_ms as number} : {})};
}

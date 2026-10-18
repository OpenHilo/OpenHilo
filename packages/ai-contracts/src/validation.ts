import {parseAiSelection} from '@openhilo/itt-contracts/ai-selection';
import type {Capability, Failure, JsonObject, JsonValue, OutputContract, TaskRequest, ValueKind} from './data';
import type {ExecutionHost} from './execution';

export class ContractError extends Error {
    constructor(readonly failure: Failure) {
        super(failure.message);
        this.name = 'ContractError';
    }
}

/** Validates data without invoking getters/toJSON. Shared references are permitted, cycles are not. */
export function isJsonValue(value: unknown): value is JsonValue {
    const ancestors = new Set<object>();
    const visit = (item: unknown): boolean => {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (typeof item !== 'object' || ancestors.has(item)) return false;
        const array = Array.isArray(item);
        const prototype = Object.getPrototypeOf(item);
        if (array && prototype !== Array.prototype) return false;
        if (!array && prototype !== Object.prototype && prototype !== null) return false;
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Reflect.ownKeys(descriptors);
        if (array && keys.length !== item.length + 1) return false;
        ancestors.add(item);
        try {
            for (const key of keys) {
                if (typeof key !== 'string') return false;
                if (array && key === 'length') continue;
                if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) return false;
                const descriptor = descriptors[key];
                if (!descriptor.enumerable || !('value' in descriptor) || !visit(descriptor.value)) return false;
            }
            return true;
        } finally {
            ancestors.delete(item);
        }
    };
    // Defensive failure for reflective errors (for example a revoked Proxy), not a sandbox.
    try {
        return visit(value);
    } catch {
        return false;
    }
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
const kinds: readonly ValueKind[] = ['text', 'number', 'boolean', 'json', 'file', 'dir'];
const capabilities: readonly Capability[] = ['structured_output', 'tools', 'workspace', 'questions', 'model_selection', 'continue', 'reconnect', 'usage', 'hard_budget'];

function reject(code: 'invalid_request' | 'unsupported_capability', message: string): never {
    throw new ContractError({code, message, retryable: false, safeToReplay: true});
}

function validOutputContract(contract: unknown): contract is OutputContract {
    return object(contract) && Object.entries(contract).every(([key, kind]) => nonempty(key) && kinds.includes(kind as ValueKind));
}

/** Checks shallow declared kinds and projects undeclared fields; this is not JSON Schema. */
export function validateOutputs(contract: OutputContract, value: unknown): JsonObject {
    const invalid = (message: string): never => {
        throw new ContractError({code: 'invalid_output', message, retryable: false, safeToReplay: false});
    };
    if (!validOutputContract(contract)) return invalid('Invalid output contract');
    if (!object(value)) return invalid('Outputs must be a JSON object');
    const projected: JsonObject = {};
    for (const [key, kind] of Object.entries(contract)) {
        if (!Object.hasOwn(value, key)) return invalid(`Missing output: ${key}`);
        const item = value[key];
        const valid = kind === 'json' || (kind === 'number' ? typeof item === 'number' : kind === 'boolean' ? typeof item === 'boolean' : typeof item === 'string');
        if (!valid) return invalid(`Output ${key} must be ${kind}`);
        Object.defineProperty(projected, key, {value: item, enumerable: true, writable: true, configurable: true});
    }
    return projected;
}

function validInstant(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    const days = new Date(0);
    days.setUTCFullYear(year, month, 0);
    return month >= 1 && month <= 12 && day >= 1 && day <= days.getUTCDate();
}

/** Validate a request and the capabilities/resources needed before any execution side effect. */
export function assertCanStart(request: TaskRequest, host: ExecutionHost, executorId: string, supported: readonly Capability[]): void {
    if (!object(request)) reject('invalid_request', 'Request must contain only JSON data');
    if (request.version !== 1 || !nonempty(request.taskId) || !nonempty(request.instruction)) reject('invalid_request', 'Invalid request version, taskId or instruction');
    if (!object(request.inputs) || !validOutputContract(request.output)) reject('invalid_request', 'Invalid inputs or output contract');
    if (request.role !== undefined && !nonempty(request.role)) reject('invalid_request', 'Invalid role');
    if (request.profile !== undefined && !nonempty(request.profile)) reject('invalid_request', 'Invalid profile');
    if (request.aiSelection !== undefined) {
        try { parseAiSelection(request.aiSelection); } catch { reject('invalid_request', 'Invalid AI selection'); }
        if (request.profile !== undefined) reject('invalid_request', 'AI selection cannot be combined with profile');
    }
    if (request.constraints !== undefined && (!Array.isArray(request.constraints) || !request.constraints.every(nonempty))) reject('invalid_request', 'Invalid constraints');
    if (!Array.isArray(request.requiredCapabilities) || !request.requiredCapabilities.every(c => capabilities.includes(c))) reject('invalid_request', 'Invalid required capabilities');
    if (request.context !== undefined && (!Array.isArray(request.context) || !request.context.every(extension => object(extension) && nonempty(extension.namespace) && positiveInteger(extension.version) && object(extension.data)))) reject('invalid_request', 'Invalid extension context');
    if (request.budget !== undefined && (!object(request.budget) || !['advisory', 'hard'].includes(request.budget.mode) || typeof request.budget.maxUsd !== 'number' || !Number.isFinite(request.budget.maxUsd) || request.budget.maxUsd < 0)) reject('invalid_request', 'Invalid budget');

    if (!nonempty(executorId) || !Array.isArray(supported) || !supported.every(c => capabilities.includes(c))) reject('invalid_request', 'Invalid executor identity or capabilities');
    if (!host || !nonempty(host.attemptId) || typeof host.onEvent !== 'function' || !host.signal || typeof host.signal.aborted !== 'boolean' || typeof host.signal.addEventListener !== 'function' || typeof host.signal.removeEventListener !== 'function') reject('invalid_request', 'Invalid execution host');
    if ((host.runId !== undefined && !nonempty(host.runId)) || (host.nodeId !== undefined && !nonempty(host.nodeId))) reject('invalid_request', 'Invalid host identity');
    resolveMonitoring(host.monitoring);
    if (host.deadlineAt !== undefined && !validInstant(host.deadlineAt)) reject('invalid_request', 'Invalid deadline');
    if (host.workspace !== undefined && (!object(host.workspace) || !nonempty(host.workspace.id) || !nonempty(host.workspace.uri))) reject('invalid_request', 'Invalid workspace');
    if (host.tools !== undefined) {
        const tools = host.tools;
        if (!tools || typeof tools.invoke !== 'function' || !Array.isArray(tools.definitions) || !isJsonValue(tools.definitions as unknown) || !tools.definitions.every(tool => object(tool) && nonempty(tool.name) && typeof tool.description === 'string' && object(tool.inputSchema))) reject('invalid_request', 'Invalid tools');
        const names = tools.definitions.map(tool => tool.name);
        if (new Set(names).size !== names.length) reject('invalid_request', 'Duplicate tool definitions');
    }

    if (request.continuation !== undefined) {
        const session = request.continuation;
        if (!object(session) || !nonempty(session.executorId) || !positiveInteger(session.version) || !nonempty(session.opaqueId) || (session.workspaceId !== undefined && !nonempty(session.workspaceId))) reject('invalid_request', 'Invalid session reference');
        if (session.executorId !== executorId) reject('invalid_request', 'Session belongs to another executor');
        if (session.workspaceId !== undefined && session.workspaceId !== host.workspace?.id) reject('invalid_request', 'Session workspace does not match host');
    }

    const required = new Set<Capability>(['structured_output', ...request.requiredCapabilities]);
    if (request.aiSelection !== undefined) required.add('model_selection');
    if (host.workspace !== undefined) required.add('workspace');
    if (host.tools !== undefined) required.add('tools');
    if (request.budget?.mode === 'hard') required.add('hard_budget');
    if (request.continuation !== undefined) required.add('continue');
    for (const capability of required) {
        if (!supported.includes(capability)) reject('unsupported_capability', `Executor does not support ${capability}`);
    }
    if (required.has('workspace') && host.workspace === undefined) reject('invalid_request', 'Workspace capability requires a host workspace');
    if (required.has('tools') && host.tools === undefined) reject('invalid_request', 'Tools capability requires a tool host');
}


/** Resolve and validate watchdog policy before an operation can create side effects. */
export function resolveMonitoring(value?: import('./execution').ExecutionMonitoring): Required<import('./execution').ExecutionMonitoring> {
    const defaults = {heartbeatMs: 5000, slowAfterMs: 60000, stalledAfterMs: 180000, stopGraceMs: 10000};
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
        throw new ContractError({
            code: 'invalid_request',
            message: 'Invalid execution monitoring',
            retryable: false,
            safeToReplay: true
        });
    }
    const result = {...defaults, ...value};
    if (Object.values(result).some(v => !Number.isSafeInteger(v) || v <= 0 || v > 2147483647) || result.slowAfterMs > result.stalledAfterMs) {
        throw new ContractError({
            code: 'invalid_request',
            message: 'Invalid execution monitoring thresholds',
            retryable: false,
            safeToReplay: true
        });
    }
    return result;
}

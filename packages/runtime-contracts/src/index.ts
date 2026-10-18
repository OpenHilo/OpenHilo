import {type ExtensionState, isJsonValue, type JsonObject} from '@openhilo/ai-contracts';
import type {ExtensionRequirement} from '@openhilo/itt-contracts';

export type {JsonObject, ExtensionState} from '@openhilo/ai-contracts';

export type {ExtensionRequirement} from '@openhilo/itt-contracts';

/** Trusted synchronous policies, supplied by composition. Every input/output is copied. */
export interface RuntimeExtensionPolicy extends ExtensionRequirement {
    derive(input: { workflow: JsonObject; parent?: JsonObject }): JsonObject;

    /** Validate and restore saved state, without silently re-deriving a new default. */
    restore(input: { workflow: JsonObject; state: JsonObject; parent?: JsonObject }): JsonObject;
}

export interface ExecutorContext {
    extensions: ExtensionState[];

    /** Attempt telemetry; synchronous observer, never execution policy. */
    onAiEvent?(event: import('@openhilo/ai-contracts').TaskEvent): void;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isObject = (value: unknown): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value);
const validIdentity = (value: ExtensionRequirement): boolean =>
    typeof value.namespace === 'string' && value.namespace.trim().length > 0 &&
    Number.isSafeInteger(value.version) && value.version > 0;

/** Owns only policy identity/version checks and JSON boundaries, never domain semantics. */
export class RuntimeExtensions {
    private readonly policies: readonly RuntimeExtensionPolicy[];

    constructor(policies: readonly RuntimeExtensionPolicy[] = []) {
        const names = new Set<string>();
        for (const policy of policies) {
            if (!validIdentity(policy) || names.has(policy.namespace) ||
                typeof policy.derive !== 'function' || typeof policy.restore !== 'function') {
                throw new Error(`Invalid or duplicate runtime extension: ${policy.namespace}`);
            }
            names.add(policy.namespace);
        }
        this.policies = policies.map(policy => ({
            namespace: policy.namespace, version: policy.version,
            derive: policy.derive.bind(policy), restore: policy.restore.bind(policy),
        }));
    }

    derive(workflow: unknown, parent: ExtensionState[] = []): ExtensionState[] {
        this.validateWorkflow(workflow);
        return this.policies.map(policy => this.invoke(policy, workflow, parent));
    }

    restore(workflow: unknown, saved: unknown, parent: ExtensionState[] = [], allowLegacy = false): ExtensionState[] {
        this.validateWorkflow(workflow);
        if (saved === undefined) {
            if (this.policies.length && !allowLegacy) throw new Error('Legacy frame has no extension state; explicit migration is required');
            return this.derive(workflow, parent);
        }
        if (!Array.isArray(saved) || !isJsonValue(saved)) throw new Error('Invalid saved extension state');
        const names = new Set<string>();
        const states: ExtensionState[] = [];
        for (const state of saved) {
            if (!isObject(state) || typeof state.namespace !== 'string' || typeof state.version !== 'number' ||
                !validIdentity({
                    namespace: state.namespace,
                    version: state.version
                }) || !isObject(state.data) || names.has(state.namespace)) {
                throw new Error('Invalid or duplicate saved extension state');
            }
            states.push({namespace: state.namespace, version: state.version, data: state.data});
            names.add(state.namespace);
            const policy = this.policies.find(p => p.namespace === state.namespace);
            if (!policy || policy.version !== state.version) throw new Error(`Missing compatible runtime extension: ${state.namespace}@${state.version}`);
        }
        if (this.policies.some(policy => !names.has(policy.namespace))) {
            throw new Error('Runtime extension set changed since this frame was saved');
        }
        return this.policies.map(policy => this.invoke(policy, workflow, parent,
            states.find(state => state.namespace === policy.namespace)!.data));
    }

    private validateWorkflow(workflow: unknown): asserts workflow is JsonObject {
        if (!isObject(workflow)) throw new Error('Workflow metadata must be JSON serializable');
        const required = workflow.requiredExtensions;
        if (required === undefined) return;
        if (!Array.isArray(required)) throw new Error('Invalid workflow extension requirements');
        const names = new Set<string>();
        for (const requirement of required) {
            if (!isObject(requirement) || typeof requirement.namespace !== 'string' || typeof requirement.version !== 'number' ||
                !validIdentity({
                    namespace: requirement.namespace,
                    version: requirement.version
                }) || names.has(requirement.namespace)) {
                throw new Error('Invalid workflow extension requirement');
            }
            names.add(requirement.namespace);
            if (!this.policies.some(p => p.namespace === requirement.namespace && p.version === requirement.version)) {
                throw new Error(`Missing compatible runtime extension: ${requirement.namespace}@${requirement.version}`);
            }
        }
    }

    private invoke(policy: RuntimeExtensionPolicy, workflow: JsonObject, parent: ExtensionState[], saved?: JsonObject): ExtensionState {
        const parentData = parent.find(state => state.namespace === policy.namespace)?.data;
        const input = {workflow: copy(workflow), ...(parentData ? {parent: copy(parentData)} : {})};
        const data = saved === undefined ? policy.derive(input) : policy.restore({...input, state: copy(saved)});
        if (!isObject(data)) throw new Error(`Non-serializable extension state from ${policy.namespace}`);
        return {namespace: policy.namespace, version: policy.version, data: copy(data)};
    }
}

export * from './state';

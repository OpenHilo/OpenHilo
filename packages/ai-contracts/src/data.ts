import type {InputShape} from '@openhilo/itt-contracts/run-inputs';
import type {AiSelection} from '@openhilo/itt-contracts/ai-selection';
/** JSON-compatible data. Runtime validation additionally requires finite numbers. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type ValueKind = 'text' | 'number' | 'boolean' | 'json' | 'file' | 'dir';
export type OutputContract = Record<string, ValueKind>;
export type Capability = 'structured_output' | 'tools' | 'workspace' | 'questions'
    | 'model_selection' | 'continue' | 'reconnect' | 'usage' | 'hard_budget';

export interface ExtensionState {
    namespace: string;
    version: number;
    data: JsonObject;
}

/** An opaque reference, never credentials or executable state. */
export interface SessionRef {
    executorId: string;
    version: number;
    opaqueId: string;
    workspaceId?: string;
}

export interface TaskRequest {
    version: 1;
    taskId: string;
    instruction: string;
    role?: string;
    constraints?: string[];
    inputs: JsonObject;
    output: OutputContract;
    /** Nested output constraints; absent retains legacy kind-only validation. */
    outputShapes?: Record<string, InputShape>;
    requiredCapabilities: Capability[];
    context?: ExtensionState[];
    aiSelection?: AiSelection;
    profile?: string;
    budget?: { mode: 'advisory' | 'hard'; maxUsd: number };
    continuation?: SessionRef;
}

export interface Artifact {
    uri: string;
    kind: 'file' | 'directory';
    origin: string;
    mediaType?: string;
}

export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    measurement: 'reported' | 'estimated';
}

export type FailureCode = 'invalid_request' | 'invalid_output' | 'unsupported_capability'
    | 'authentication_failed' | 'rate_limited' | 'quota_exhausted' | 'timeout'
    | 'tool_failed' | 'executor_failed' | 'outcome_unknown';

export interface Failure {
    code: FailureCode;
    message: string;
    retryable: boolean;
    /** Whether replay is known not to duplicate effects; independent of retryability. */
    safeToReplay: boolean;
    retryAfterMs?: number;
    details?: JsonObject;
}

export type TaskResult =
    | { status: 'completed'; outputs: JsonObject; artifacts: Artifact[]; usage?: Usage; session?: SessionRef }
    | { status: 'failed'; error: Failure; usage?: Usage; session?: SessionRef }
    | { status: 'cancelled'; reason: string; usage?: Usage; session?: SessionRef };

export interface Availability {
    status: 'available' | 'unavailable' | 'unknown';
    observedAt: string;
    reason?: string;
    retryAfterMs?: number;
}

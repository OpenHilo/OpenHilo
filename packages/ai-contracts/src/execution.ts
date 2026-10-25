import type {
    Availability,
    Capability,
    Failure,
    JsonObject,
    JsonValue,
    SessionRef,
    TaskRequest,
    TaskResult,
    Usage,
} from './data';

export interface Question {
    id: string;
    prompt: string;
    options?: { label: string; value: string; recommended?: boolean; reason?: string }[];
    /** Suggested by default; exclusive restricts answers to the listed option values. */
    optionsMode?: 'suggested' | 'exclusive';
    answer: 'text' | 'json';
}

/** Watchdog liveness is not proof of provider progress or rollback. Milliseconds. */
export interface ExecutionMonitoring {
    heartbeatMs?: number;
    slowAfterMs?: number;
    stalledAfterMs?: number;
    stopGraceMs?: number;
}

export interface ExecutionHealth {
    phase: 'starting' | 'model' | 'tool' | 'waiting_for_input' | 'cleanup' | 'stopping';
    condition: 'active' | 'slow' | 'stalled';
    elapsedMs: number;
    idleMs: number;
    phaseElapsedMs: number;
    activeTools: number;
    stalledTools: { callId: string; tool: string; elapsedMs: number }[];
    /** Detect stale snapshots/worker loss separately from a stalled provider. */
    observedAt: string;
    heartbeatMs: number;
    /** Projected deadline while running; omitted while the active-time budget is paused. */
    deadlineAt?: string;
    /** Elapsed/remaining execution budget excludes time with pending questions. */
    activeElapsedMs?: number;
    remainingMs?: number;
    stopReason?: 'cancelled' | 'timeout';
}

export type EventPayload =
    | { type: 'started' }
    | { type: 'phase'; phase: 'starting' | 'model' | 'cleanup' }
    | { type: 'health'; health: ExecutionHealth }
    | { type: 'progress'; message: string }
    | { type: 'question'; question: Question }
    | { type: 'answered'; questionId: string }
    | { type: 'tool_started'; callId: string; tool: string }
    | { type: 'tool_finished'; callId: string; tool: string; outcome: 'completed' | 'failed' }
    | { type: 'usage'; usage: Usage }
    | { type: 'terminal'; result: TaskResult };

/** Ordered within an attempt; timestamp is an ISO 8601 instant. */
export type TaskEvent = EventPayload & {
    taskId: string;
    attemptId: string;
    sequence: number;
    timestamp: string;
};

export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: JsonObject;
}

export interface ToolHost {
    definitions: readonly ToolDefinition[];

    invoke(call: { callId: string; name: string; arguments: JsonObject }, signal: AbortSignal):
        Promise<{ ok: true; output: JsonValue } | { ok: false; error: Failure }>;
}

/** Live resources are deliberately separate from serializable TaskRequest. */
export interface ExecutionHost {
    attemptId: string;
    runId?: string;
    nodeId?: string;
    workspace?: { id: string; uri: string };
    tools?: ToolHost;
    signal: AbortSignal;
    /** Initial execution deadline; remaining budget pauses during questions. Defaults to 12 hours. */
    deadlineAt?: string;
    /** Defaults: heartbeat 5s, slow 60s, stalled 180s, stop grace 10s. */
    monitoring?: ExecutionMonitoring;

    /** Synchronous observer. Observer exceptions must never affect execution or cause replay. */
    onEvent(event: TaskEvent): void;
}

export type ExecutionState = 'running' | 'waiting_for_input' | 'stopping' | TaskResult['status'];
export type AnswerReceipt = 'accepted' | 'duplicate' | 'unknown_question' | 'invalid_answer' | 'closed';

export interface AiExecution {
    /** Opaque recoverable identity when available; does not itself promise reconnect. */
    readonly session?: SessionRef;
    readonly state: ExecutionState;
    /** Optional for external implementations; supplied by createTaskExecution. */
    readonly health?: ExecutionHealth;
    /** Authoritative outcome. Accepted executions settle once, including failure/cancellation. */
    readonly result: Promise<TaskResult>;

    answer(questionId: string, value: JsonValue): Promise<AnswerReceipt>;

    cancel(reason: string): Promise<void>;
}

export interface AiTaskExecutor {
    readonly id: string;
    readonly capabilities: readonly Capability[];

    /** Rejection is reserved for pre-execution errors; acceptance returns a live handle. */
    start(request: TaskRequest, host: ExecutionHost): Promise<AiExecution>;

    /** Release an idle continuation session after its workflow is finished. */
    releaseSession?(session: SessionRef): Promise<void>;

    availability?(): Promise<Availability>;

    reconnect?(session: SessionRef, host: ExecutionHost): Promise<AiExecution>;
}

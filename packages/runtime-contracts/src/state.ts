import type {Failure as AiFailure} from '@openhilo/ai-contracts';
import type {CFGNode, Value} from '@openhilo/itt-contracts';

// ============================================================================
// Scope 类型
// ============================================================================

export interface BaseScope {
    kind: 'base';
    vars: Record<string, Value>;
}

export interface LoopContextScope {
    kind: 'loop-context';
    loopNodeId: string;
    nextBody: string;
    nextExit: string;
    vars: Record<string, Value>;
    // foreach 专用
    array?: Value[];
    cursor?: number;
}

export interface IterationScope {
    kind: 'iteration';
    vars: Record<string, Value>;
}

export type Scope = BaseScope | LoopContextScope | IterationScope;

/** scope_stack 快照（用于 checkpoint 序列化） */
export type ScopeStackSnapshot = Scope[];

// ============================================================================
// 执行帧与调度器上下文
// ============================================================================

/** 单个 ITT 的执行上下文帧 */
export interface ExecutionFrame {
    frame_id: string;
    intent_name: string;
    nodes: Record<string, CFGNode>;   // 从 snapshot 加载，只读
    current_node: string;
    call_node_run_id?: string;        // path one sub-ITT 时记录父 call 节点的 run_id
    scope_stack: Scope[];             // 由 ScopeManager 管理
    return_context: {
        parent_call_node_id: string;
        outputs_to: Record<string, string>;  // sub-ITT outputKey → 父 scope 变量名
    } | null;
}

// ============================================================================
// 错误类型
// ============================================================================

/**
 * AbortError：不可恢复错误（EvalEngine 失败、BREAK/CONTINUE 越界、类型错误等）。
 * 触发 run 终态 = "aborted"（不可 resume）。
 */
export class AbortError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbortError';
        Object.setPrototypeOf(this, AbortError.prototype);
    }
}

/**
 * FailableError：executor 执行失败（ai/code/human）。
 * 若节点有 on_failure 则路由；否则：ai/code/human → "failed"（可 resume）。
 */
export interface ExecutionDiagnostics {
    stdout?: string; stderr?: string; exitCode?: number;
    /** Unvalidated output values serialized as JSON, bounded for diagnostics only. */
    rawOutputs?: string; truncated?: boolean;
}
export class FailableError extends Error {
    constructor(message: string, public readonly aiFailure?: AiFailure, public readonly diagnostics?: ExecutionDiagnostics) {
        super(message);
        this.name = 'FailableError';
        Object.setPrototypeOf(this, FailableError.prototype);
    }
}

// ============================================================================
// 事件日志类型
// ============================================================================

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'suspended';

/** Decoded in-memory events. JSONL checkpoint payloads use PersistedLogEvent. */
export type LogEvent =
    | { event: 'run_start'; ts: number; run_id: string; intent: string; workdir: string }
    | { event: 'run_resume'; ts: number; run_id: string; intent: string; current_node: string }
    | { event: 'sys_var_inject'; ts: number; vars: Record<string, Value> }
    | { event: 'inputs_inject'; ts: number; vars: Record<string, Value> }
    | { event: 'run_complete'; ts: number; status: 'completed'; outputs: Record<string, Value> }
    | { event: 'run_abort'; ts: number; node_run_id: string | null; reason: string }
    | { event: 'run_failed'; ts: number; node_run_id: string; reason: string; failure?: AiFailure }
    | {
    event: 'node_pending';
    ts: number;
    node_id: string;
    node_run_id: string;
    node_type: string;
    executor?: string;
    frame_id?: string;
    intent_name?: string;
    inputs: Record<string, Value>
}
    | {
    event: 'ai_health';
    ts: number;
    node_run_id: string;
    task_id: string;
    attempt_id: string;
    sequence: number;
    health: import('@openhilo/ai-contracts').ExecutionHealth
}
    | { event: 'ai_progress'; ts: number; node_run_id: string; task_id: string; attempt_id: string; sequence: number; message: string }
    | { event: 'node_running'; ts: number; node_run_id: string }
    | { event: 'node_success'; ts: number; node_run_id: string; outputs: Record<string, Value> }
    | {
    event: 'node_failed';
    ts: number;
    node_run_id: string;
    node_type?: string;
    executor?: string;
    error: string;
    on_failure: string | null;
    failure?: AiFailure;
    diagnostics?: ExecutionDiagnostics
}
    | { event: 'node_suspended'; ts: number; node_run_id: string; reason: 'waiting_human'; task_id?: string }
    | {
    event: 'human_delivery_failed';
    ts: number;
    node_run_id: string;
    task_id: string;
    adapter_id: string;
    error: string
}
    | { event: 'human_submitted'; ts: number; node_run_id: string; task_id: string; submission_id: string }
    | { event: 'checkpoint'; ts: number; node_run_id: string; call_stack: CheckpointFrame[]; global_seq: number }
    | { event: 'suspended_state'; ts: number; call_stack: CheckpointFrame[]; global_seq: number }
    | { event: 'frame_push'; ts: number; frame_id: string; callee: string; inputs: Record<string, Value> }
    | { event: 'frame_pop'; ts: number; frame_id: string; outputs: Record<string, Value> }
    | {
    event: 'continue_inline';
    ts: number;
    trigger_node_run_id: string;
    loop_node_id: string;
    step_results: Record<string, Value>;
    condition_result: boolean;
    next: string
};

/** checkpoint 事件中的帧快照格式 */
export interface CheckpointFrame {
    /** Absent only in legacy snapshots; an empty array records a generic frame. */
    extension_state?: import('@openhilo/ai-contracts').ExtensionState[];
    frame_id: string;
    intent_name: string;
    current_node: string;
    call_node_run_id?: string;
    scope_stack: ScopeStackSnapshot;
    return_context: ExecutionFrame['return_context'];
    /** Inputs already resolved for current_node; resume reuses them instead of re-evaluating. Absent in legacy snapshots. */
    pending_call?: { node_id: string; inputs: Record<string, Value> };
}

// ============================================================================
// run.json 结构
// ============================================================================

export interface RunJson {
    run_id: string;
    intent: string;
    workdir: string;       // ITT_WORKSPACE 绝对路径
    status: RunStatus;
    created_at: string;    // ISO 8601
    updated_at: string;
}

/** ExecutionError — executor 运行时错误 */
export class ExecutionError extends Error {
    constructor(message: string, public readonly sessionId: string, public readonly executor: string) {
        super(message);
        this.name = 'ExecutionError';
        Object.setPrototypeOf(this, ExecutionError.prototype);
    }
}

/** Versioned JSONL state graph; runtime LogEvent observers still receive decoded frames. */
export type GraphValue = null | boolean | number | string | { ref: number };
export type GraphNode = { kind: 'object'; entries: [string, GraphValue][] } | { kind: 'array'; items: GraphValue[] };

export interface StateGraph {
    format: 'openhilo-state-graph';
    version: 1;
    root: GraphValue;
    nodes: GraphNode[];
}

export type PersistedLogEvent = Exclude<LogEvent, { event: 'checkpoint' | 'suspended_state' }> |
    (Omit<Extract<LogEvent, { event: 'checkpoint' }>, 'call_stack'> & { call_stack: CheckpointFrame[] | StateGraph }) |
    (Omit<Extract<LogEvent, { event: 'suspended_state' }>, 'call_stack'> & {
        call_stack: CheckpointFrame[] | StateGraph
    });

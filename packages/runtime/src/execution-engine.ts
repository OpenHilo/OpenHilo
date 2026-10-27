import type {EvaluationOptions} from './eval-engine';
import {isFileRef, type ValueType} from '@openhilo/itt-contracts';
import {
    assertReturnValue,
    assertWorkflowValue,
    copyWorkflowValue,
    createStateCopier,
    setValueField
} from './workflow-value';
import {readSnapshot, snapshotFile} from './snapshot';
import {parseHumanOutputs} from '@openhilo/itt-contracts/human-output';
import {type HumanExecutor, type HumanSubmission, type HumanTaskRequest} from '@openhilo/human-contracts';
import {persistHumanTask, readHumanSubmission, submitHumanTask} from './human-tasks';
/**
 * ExecutionEngine — CFG 主状态机
 *
 * 单层 while True outer loop，处理：
 *   A 段：END 检查（sub-ITT pop / 顶层完成）
 *   B 段：node_pending
 *   C 段：path one call（impl sub-ITT）
 *   D 段：控制流节点立即写 node_running
 *   E 段：执行节点
 *   F 段：node_success
 *   G 段：BREAK/CONTINUE 内联处理
 */
import * as crypto from 'crypto';
import {
    type ExecutorContext,
    type ExtensionState,
    type RuntimeExtensionPolicy,
    RuntimeExtensions
} from '@openhilo/runtime-contracts';
import {
    AbortError,
    type CFGITT,
    type CFGNode,
    type CheckpointFrame,
    FailableError,
    type LogEvent,
    type Value,
} from './types';
import {ScopeManager} from './scope-manager';
import {Logger} from './logger';

// ── 公开接口 ──────────────────────────────────────────────────────────────────

/** Executor 函数签名：接收节点描述和已解析 inputs，返回 outputs */
export type ExecutorFn = (node: CFGNode, inputs: Record<string, Value>, context?: ExecutorContext) => Promise<{
    outputs: Record<string, Value>
}>;

/** RunManager stub（只需 update_status） */
export interface RunManagerStub {
    update_status(status: string): void;
}

/** EvalEngine stub */
export interface EvalEngineStub {
    start(): void;

    stop(): Promise<void>;

    eval(expr: string, vars: Record<string, Value>, options?: EvaluationOptions): Promise<Value>;
}

export interface ExecutionEngineOpts {
    runId: string;
    runDir: string;
    workdir: string;       // ITT_WORKSPACE — user's working directory
    snapshotDir: string;
    intentName: string;
    inputs: Record<string, Value>;
    evalEngine: EvalEngineStub;
    runManager: RunManagerStub;
    executor?: ExecutorFn;          // 可注入 mock
    onEvent?: (ev: LogEvent) => void;
    pendingHumanOutput?: Record<string, string>;
    pendingHumanSubmission?: HumanSubmission;
    pendingHumanTask?: HumanTaskRequest;
    humanExecutor?: HumanExecutor;
    checkpointsEnabled?: boolean;   // --checkpoints: 每节点执行前写 checkpoint 事件（供 branch 用）
    resumeFrom?: {                  // resume 路径：从 Rehydrator 恢复的 callStack + globalSeq
        callStack: CheckpointFrame[];
        globalSeq: number;
    };
    /** Compatibility hint for composition roots; Runtime only uses humanExecutor. */
    humanMode?: 'interactive' | 'suspend';
    /** Legacy composition hint; Runtime itself does not prompt. */
    promptFn?: (prompt: string) => Promise<string>;
    /** Application policies; absent means an empty generic context. */
    extensions?: readonly RuntimeExtensionPolicy[];
    /** Explicit compatibility path for snapshots predating persisted extension state. */
    allowLegacyExtensionRestore?: boolean;
}

/** human 节点挂起时抛出此错误 */
export class HumanSuspendedError extends Error {
    constructor(public readonly nodeId: string) {
        super(`Human executor suspended at node: ${nodeId}`);
        this.name = 'HumanSuspendedError';
    }
}

// ── ExecutionFrame（内部） ─────────────────────────────────────────────────────

interface Frame {
    frameId: string;
    intentName: string;
    nodes: Record<string, CFGNode>;
    currentNode: string;
    callNodeRunId?: string;
    scope: ScopeManager;
    returnContext: {
        parentCallNodeId: string;
        outputsTo: Record<string, string>;
        topLevelOutputs: Record<string, string>;
    } | null;
    extensions: ExtensionState[];
    /** Resolved inputs of the in-flight call; checkpointed so resume never re-evaluates them. */
    pendingCall?: { nodeId: string; inputs: Record<string, Value> };
}

// ═══════════════════════════════════════════════════════════════════════════════

export class ExecutionEngine {
    private callStack: Frame[] = [];
    private readonly cfg: ExecutionEngineOpts;
    private resumeFrom: ExecutionEngineOpts['resumeFrom'];
    private globalSeq = 0;
    private readonly extensions: RuntimeExtensions;
    private logger: Logger;
    private pendingHumanOutput: Record<string, string> | undefined;
    private pendingHumanSubmission: HumanSubmission | undefined;
    private pendingHumanTask: HumanTaskRequest | undefined;
    private readonly snapshots = new Map<string, CFGITT>();
    private readonly handlerLeavesLoop = new Map<string, boolean>();

    constructor(cfg: ExecutionEngineOpts) {
        this.cfg = {
            ...cfg, resumeFrom: undefined, pendingHumanOutput: undefined,
            pendingHumanSubmission: undefined, pendingHumanTask: undefined
        };
        this.resumeFrom = cfg.resumeFrom;
        this.extensions = new RuntimeExtensions(cfg.extensions);
        this.logger = new Logger(cfg.runDir, cfg.runId);
        this.pendingHumanOutput = cfg.pendingHumanOutput;
        this.pendingHumanSubmission = cfg.pendingHumanSubmission;
        this.pendingHumanTask = cfg.pendingHumanTask;

    }

    /**
     * 主入口：执行 ITT，返回顶层 scope 的 visible_vars 快照。
     * 异常：AbortError（不可恢复）、FailableError（AI/Human 无 on_failure）、HumanSuspendedError
     */
    async run(): Promise<Record<string, Value>> {
        // 加载顶层 ITT（start/resume 均需要）
        const rootITT = this.loadITT(this.cfg.intentName);

        if (this.resumeFrom) {
            // ── resume 路径：从 suspended_state 恢复完整状态 ────────────────────────
            this.globalSeq = this.resumeFrom.globalSeq;
            this.restoreFrames(this.resumeFrom.callStack);
            // Restored scopes own their values; do not pin the old checkpoint for this run.
            this.resumeFrom = undefined;
            // A restored checkpoint is now executing, including when a previously
            // submitted human result skips the interactive presentation path.
            this.cfg.runManager.update_status('running');
            this.emit({
                event: 'run_resume', ts: now(),
                run_id: this.cfg.runId,
                intent: this.cfg.intentName,
                current_node: this.callStack[this.callStack.length - 1].currentNode,
            });
        } else {
            // ── start 路径：全新运行 ────────────────────────────────────────────────
            assertWorkflowValue(this.cfg.inputs);
            this.logger.init();
            const rootScope = new ScopeManager();
            rootScope.push({kind: 'base', vars: {}});
            // 注入 ITT_WORKSPACE（用户工作目录）
            rootScope.write('ITT_WORKSPACE', this.cfg.workdir);
            // 注入 inputs
            for (const [k, v] of Object.entries(copyWorkflowValue(this.cfg.inputs))) {
                rootScope.write(k, this.boundaryValue(v, rootITT.inputs?.[k]?.kind, rootITT));
            }

            const rootFrame: Frame = {
                frameId: `${this.cfg.runId}_f1`,
                intentName: this.cfg.intentName,
                nodes: rootITT.nodes,
                currentNode: rootITT.entry,
                scope: rootScope,
                returnContext: null,
                extensions: this.resolveExtensions(rootITT, []),
            };
            this.callStack.push(rootFrame);
            this.emit({
                event: 'run_start',
                ts: now(),
                run_id: this.cfg.runId,
                intent: this.cfg.intentName,
                workdir: this.cfg.workdir
            });
            this.emit({event: 'sys_var_inject', ts: now(), vars: {ITT_WORKSPACE: this.cfg.workdir}});
            if (Object.keys(this.cfg.inputs).length > 0) {
                this.emit({event: 'inputs_inject', ts: now(), vars: this.cfg.inputs});
            }
        }

        // ── outer execution loop ──────────────────────────────────────────────────
        while (true) {
            const currentFrame = this.callStack[this.callStack.length - 1];

            // ── A: END 检查 ─────────────────────────────────────────────────────────
            if (currentFrame.currentNode === 'END') {
                if (this.callStack.length > 1) {
                    try {
                        this.popCallFrame();
                    } catch (error) {
                        if (error instanceof AbortError) {
                            const callId = currentFrame.callNodeRunId ?? 'unknown';
                            this.emit({
                                event: 'node_failed',
                                ts: now(),
                                node_run_id: callId,
                                error: error.message,
                                on_failure: null
                            });
                            this.emitRunAbort(callId, error.message);
                        }
                        throw error;
                    }
                    continue;
                } else {
                    // 顶层完成
                    let outputs: Record<string, Value>;
                    try {
                        outputs = this.collectTopLevelOutputs(currentFrame, rootITT);
                    } catch (e) {
                        if (e instanceof AbortError) {
                            this.emit({
                                event: 'run_abort',
                                ts: now(),
                                node_run_id: null,
                                reason: `output collection failed: ${e.message}`
                            });
                            this.cfg.runManager.update_status('aborted');
                            throw e;
                        }
                        throw e;
                    }
                    this.emit({event: 'run_complete', ts: now(), status: 'completed', outputs});
                    this.cfg.runManager.update_status('completed');
                    return currentFrame.scope.visible_vars();
                }
            }

            const nodeId = currentFrame.currentNode;
            const node = currentFrame.nodes[nodeId];
            if (!node) throw new AbortError(`Node not found: ${nodeId}`);

            const nodeRunId = this.generateNodeRunId();
            const scope = currentFrame.scope;

            // ── B: node_pending ─────────────────────────────────────────────────────
            const pendingInputs = this.buildPendingInputs(node, scope);
            this.emit({
                event: 'node_pending', ts: now(),
                node_id: nodeId, node_run_id: nodeRunId,
                frame_id: currentFrame.frameId, intent_name: currentFrame.intentName,
                node_type: node.type,
                executor: node.type === 'call' ? node.executor : undefined,
                inputs: pendingInputs,
            });

            // ── B2: [可选] --checkpoints 模式：执行前写 checkpoint（供 branch 用）─
            if (this.cfg.checkpointsEnabled) {
                this.emit({
                    event: 'checkpoint', ts: now(),
                    node_run_id: nodeRunId,
                    call_stack: this.serializeCallStack(),
                    global_seq: this.globalSeq,
                });
            }

            // ── C: path one call（impl sub-ITT）──────────────────────────────
            // Code/system calls stay with their executor even when a workflow shares the name.
            // An AI/Human leaf may share its enclosing workflow's name.
            // Delegating it back to the current implementation would recurse without ever asking.
            const executorSelfCall = node.type === 'call' && ['ai', 'human'].includes(node.executor) && node.callee === currentFrame.intentName;
            // Explicit AI selection must reach the router, even if a different workflow shares the name.
            const routedAiCall = node.type === 'call' && node.executor === 'ai' && node.aiSelection !== undefined;
            if (node.type === 'call' && node.executor !== 'code' && node.executor !== 'sys' && !executorSelfCall && !routedAiCall && this.isImpl(node.callee)) {
                try {
                    const inputs = await this.resolveInputsFrom(node, scope);
                    this.emit({event: 'node_running', ts: now(), node_run_id: nodeRunId});
                    const newFrameId = this.newFrameId();
                    this.emit({event: 'frame_push', ts: now(), frame_id: newFrameId, callee: node.callee!, inputs});
                    const subITT = this.loadITT(node.callee!);
                    const subScope = new ScopeManager();
                    subScope.push({kind: 'base', vars: {}});
                    subScope.write('ITT_WORKSPACE', this.cfg.workdir);
                    for (const [k, v] of Object.entries(inputs)) subScope.write(k, this.boundaryValue(v, subITT.inputs?.[k]?.kind, subITT));
                    const newFrame: Frame = {
                        frameId: newFrameId,
                        intentName: node.callee!,
                        nodes: subITT.nodes,
                        currentNode: subITT.entry,
                        callNodeRunId: nodeRunId,
                        scope: subScope,
                        returnContext: {
                            parentCallNodeId: nodeId,
                            outputsTo: node.outputsTo,
                            topLevelOutputs: subITT.outputs ?? {},
                        },
                        extensions: this.resolveExtensions(subITT, currentFrame.extensions),
                    };
                    this.callStack.push(newFrame);
                    continue;
                } catch (e) {
                    if (e instanceof AbortError) {
                        this.emit({
                            event: 'node_failed',
                            ts: now(),
                            node_run_id: nodeRunId,
                            error: e.message,
                            on_failure: null
                        });
                        this.emitRunAbort(nodeRunId, e.message);
                        throw e;
                    }
                    throw e;
                }
            }

            if (node.type === 'call' && node.executor === 'intent' && node.callee && !this.isImpl(node.callee)) {
                const error = new AbortError(
                    `Call node "${node.id}" with executor "${node.executor}" requires impl ITT for callee "${node.callee}"`,
                );
                this.emit({
                    event: 'node_failed',
                    ts: now(),
                    node_run_id: nodeRunId,
                    error: error.message,
                    on_failure: null
                });
                this.emitRunAbort(nodeRunId, error.message);
                throw error;
            }

            // ── D: 控制流节点立即写 node_running ────────────────────────────────────
            if (node.type !== 'call') {
                this.emit({event: 'node_running', ts: now(), node_run_id: nodeRunId});
            }

            // ── E: 执行节点 ─────────────────────────────────────────────────────────
            try {
                let rawNext: string;
                let outputs: Record<string, Value>;

                switch (node.type) {
                    case 'assign':
                        [rawNext, outputs] = await this.executeAssign(node, scope);
                        break;
                    case 'if':
                        [rawNext, outputs] = await this.executeIf(node, scope);
                        break;
                    case 'for':
                        [rawNext, outputs] = await this.executeFor(node, scope);
                        break;
                    case 'foreach':
                        [rawNext, outputs] = await this.executeForeach(node, scope);
                        break;
                    case 'call':
                        [rawNext, outputs] = await this.executeCallPathTwo(node, scope, nodeRunId);
                        break;
                    default:
                        throw new AbortError(`Unknown node type: ${(node as CFGNode).type}`);
                }
                currentFrame.pendingCall = undefined;

                for (const frame of this.callStack) frame.scope.normalizeValues();

                // ── F: node_success ──────────────────────────────────────────────────
                this.emit({event: 'node_success', ts: now(), node_run_id: nodeRunId, outputs});

                // ── G: BREAK / CONTINUE 内联处理 ────────────────────────────────────
                let actualNext: string;
                if (rawNext === 'BREAK') {
                    actualNext = this.handleBreak(scope);
                    currentFrame.currentNode = actualNext;
                } else if (rawNext === 'CONTINUE') {
                    actualNext = await this.handleContinue(nodeRunId, scope, currentFrame);
                    scope.normalizeValues();
                    currentFrame.currentNode = actualNext;
                } else {
                    actualNext = rawNext;
                    currentFrame.currentNode = actualNext;
                }

            } catch (e) {
                if (e instanceof HumanSuspendedError) throw e;

                if (e instanceof AbortError) {
                    this.emit({
                        event: 'node_failed',
                        ts: now(),
                        node_run_id: nodeRunId,
                        error: e.message,
                        on_failure: null
                    });
                    if (this.callStack.length > 1) {
                        const parentCallNodeRunId = currentFrame.callNodeRunId;
                        if (parentCallNodeRunId) {
                            this.emit({
                                event: 'node_failed',
                                ts: now(),
                                node_run_id: parentCallNodeRunId,
                                error: `sub-ITT aborted: ${e.message}`,
                                on_failure: null
                            });
                        }
                    }
                    this.emitRunAbort(nodeRunId, e.message);
                    throw e;
                }

                if (e instanceof FailableError) {
                    // FailableError can only originate from executors (call nodes); the
                    // `node.type !== 'call'` branches are defensive guards.
                    /* istanbul ignore next */
                    const onFailure = node.type === 'call' ? (node.on_failure ?? 'ABORT') : 'ABORT';
                    /* istanbul ignore next */
                    const nodeExecutor = node.type === 'call' ? node.executor : undefined;
                    this.emit({
                        event: 'node_failed', ts: now(), node_run_id: nodeRunId,
                        node_type: node.type, executor: nodeExecutor,
                        error: e.message, on_failure: onFailure,
                        ...(e.aiFailure ? {failure: e.aiFailure} : {}),
                        ...(e.diagnostics ? {diagnostics: e.diagnostics} : {}),
                    });
                    if (onFailure && onFailure !== 'ABORT') {
                        currentFrame.pendingCall = undefined;
                        this.unwindLoopsFor(currentFrame, onFailure);
                        currentFrame.currentNode = onFailure;
                        continue;
                    }
                    // Executor failures retain the same checkpoint used by Human recovery.
                    const executor = nodeExecutor;
                    if (executor === 'ai' || executor === 'human' || executor === 'code') {
                        this.emit({
                            event: 'run_failed', ts: now(), node_run_id: nodeRunId, reason: e.message,
                            ...(e.aiFailure ? {failure: e.aiFailure} : {})
                        });
                        this.writeSuspendedState();
                        this.cfg.runManager.update_status('failed');
                    } else {
                        this.emitRunAbort(nodeRunId, e.message);
                    }
                    throw e;
                }

                throw e;
            }
        }
    }

    /** Synchronous restoration keeps raw checkpoint references out of the async run frame. */
    private restoreFrames(callStack: CheckpointFrame[]): void {
        const copy = createStateCopier();
        for (const cf of callStack) {
            const itt = this.loadITT(cf.intent_name);
            const scope = new ScopeManager();
            scope.deserialize(cf.scope_stack, copy);
            const returnContext = cf.return_context
                ? {
                    parentCallNodeId: cf.return_context.parent_call_node_id,
                    outputsTo: cf.return_context.outputs_to,
                    topLevelOutputs: itt.outputs ?? {},
                }
                : null;
            const parent = this.callStack.at(-1)?.extensions ?? [];
            this.callStack.push({
                frameId: cf.frame_id,
                intentName: cf.intent_name,
                nodes: itt.nodes,
                currentNode: cf.current_node,
                callNodeRunId: cf.call_node_run_id,
                scope,
                returnContext,
                extensions: this.resolveExtensions(itt, parent, cf),
                ...(cf.pending_call ? {pendingCall: this.restorePendingCall(cf, copy)} : {}),
            });
        }
    }

    // ── 节点执行函数 ──────────────────────────────────────────────────────────────

    private async executeAssign(node: Extract<CFGNode, {
        type: 'assign'
    }>, scope: ScopeManager): Promise<[string, Record<string, Value>]> {
        const writes: Record<string, Value> = {};
        for (const {var: varName, expr} of node.assignments) {
            const result = await this.evalExpression(expr, scope.visible_vars());
            scope.write(varName, result);
            setValueField(writes, varName, result);
        }
        return [node.next, {writes}];
    }

    private async executeIf(node: Extract<CFGNode, {
        type: 'if'
    }>, scope: ScopeManager): Promise<[string, Record<string, Value>]> {
        const result = Boolean(await this.evalExpression(node.condition, scope.visible_vars()));
        const branch = result ? 'next_true' : 'next_false';
        const next = result ? node.next_true : node.next_false;
        return [next, {condition_result: result, branch}];
    }

    private async executeFor(node: Extract<CFGNode, {
        type: 'for'
    }>, scope: ScopeManager): Promise<[string, Record<string, Value>]> {
        const isFirst = !scope.has_loop_context(node.id);

        let scopeWrites: Record<string, Value> = {};

        if (isFirst) {
            // 先写 init 变量到当前 scope（循环退出后变量仍可见）
            for (const {var: v, expr} of node.init) {
                const val = await this.evalExpression(expr, scope.visible_vars());
                scope.write(v, val);
                setValueField(scopeWrites, v, val);
            }
            // 再推 loop-context（metadata only，vars 为空）
            scope.push({
                kind: 'loop-context',
                loopNodeId: node.id,
                nextBody: node.next_body,
                nextExit: node.next_exit,
                vars: {}
            });
        } else {
            scope.pop_iteration_with_promotion();  // pop iteration-scope，vars 提升到 loop-context
            for (const {var: v, expr} of node.step) {
                const val = await this.evalExpression(expr, scope.visible_vars());
                scope.write(v, val);
                setValueField(scopeWrites, v, val);
            }
        }

        const condResult = Boolean(await this.evalExpression(node.condition, scope.visible_vars()));

        let next: string;
        if (condResult) {
            scope.push({kind: 'iteration', vars: {}});
            next = node.next_body;
        } else {
            const loopCtx = scope.loop_context(node.id);
            next = loopCtx.nextExit;
            scope.promote_and_pop_until_including(loopCtx);  // loop 内变量提升到父 scope
        }

        return [next, {
            iteration: isFirst ? 'first' : 'subsequent',
            condition_result: condResult,
            scope_writes: scopeWrites,
            next,
        }];
    }

    private async executeForeach(node: Extract<CFGNode, {
        type: 'foreach'
    }>, scope: ScopeManager): Promise<[string, Record<string, Value>]> {
        const isFirst = !scope.has_loop_context(node.id);

        if (isFirst) {
            const array = await this.evalExpression(node.array_expr, scope.visible_vars());
            if (!Array.isArray(array)) throw new AbortError('array_expr must evaluate to a list');
            scope.push({
                kind: 'loop-context',
                loopNodeId: node.id,
                nextBody: node.next_body,
                nextExit: node.next_exit,
                vars: {},
                array,
                cursor: 0
            });
        } else {
            scope.pop_iteration_with_promotion();  // pop iteration-scope，vars 提升到 loop-context
            const ctx = scope.loop_context(node.id);
            ctx.cursor = /* istanbul ignore next */ (ctx.cursor ?? 0) + 1;
        }

        const loopCtx = scope.loop_context(node.id);
        const cursor = /* istanbul ignore next */ loopCtx.cursor ?? 0;
        const array = loopCtx.array!;

        let next: string;
        let itemWritten: Value = null;

        if (cursor < array.length) {
            scope.push({kind: 'iteration', vars: {}});
            itemWritten = array[cursor];
            scope.write(node.item_var, itemWritten);
            if (node.index_var) scope.write(node.index_var, cursor);
            next = node.next_body;
        } else {
            next = loopCtx.nextExit;
            scope.promote_and_pop_until_including(loopCtx);  // loop 内变量提升到父 scope
        }

        return [next, {iteration: isFirst ? 'first' : 'subsequent', cursor, item_value: itemWritten, next}];
    }

    private async executeCallPathTwo(
        node: Extract<CFGNode, { type: 'call' }>,
        scope: ScopeManager,
        nodeRunId: string,
    ): Promise<[string, Record<string, Value>]> {
        const frame = this.callStack.at(-1)!;
        const inputs = frame.pendingCall?.nodeId === node.id
            ? frame.pendingCall.inputs
            : copyWorkflowValue(await this.resolveInputsFrom(node, scope));
        frame.pendingCall = {nodeId: node.id, inputs};
        this.logger.write_inputs_record(nodeRunId, inputs);

        // human executor
        if (node.executor === 'human') {
            return this.executeHuman(node, scope, nodeRunId, inputs);
        }

        this.emit({event: 'node_running', ts: now(), node_run_id: nodeRunId});

        const executorFn = this.cfg.executor;
        if (!executorFn) throw new AbortError(`No executor configured for node: ${node.id}`);

        let acceptingEvents = true;
        let progressBytes = 0;
        const maxProgressBytes = 200_000;
        const context: ExecutorContext = {
            extensions: JSON.parse(JSON.stringify(this.callStack.at(-1)!.extensions)),
            onAiEvent: event => {
                if (acceptingEvents && ['progress', 'tool_started', 'tool_finished'].includes(event.type) && progressBytes <= maxProgressBytes) {
                    const text = event.type === 'progress' ? event.message : event.type === 'tool_started' ? `\n[Tool started: ${event.tool}]\n` : event.type === 'tool_finished' ? `\n[Tool ${event.outcome}: ${event.tool}]\n` : '';
                    const message = text.slice(0, Math.max(0, maxProgressBytes - progressBytes));
                    progressBytes += text.length;
                    this.emit({event: 'ai_progress', ts: now(), node_run_id: nodeRunId, task_id: event.taskId, attempt_id: event.attemptId, sequence: event.sequence, message: message + (progressBytes > maxProgressBytes ? '\n[Output limit reached for this step.]' : '')});
                }
                if (acceptingEvents && event.type === 'health') this.emit({
                    event: 'ai_health', ts: now(), node_run_id: nodeRunId,
                    task_id: event.taskId, attempt_id: event.attemptId, sequence: event.sequence, health: event.health
                });
            },
        };
        let result: Awaited<ReturnType<ExecutorFn>>;
        try {
            result = await executorFn(node, copyWorkflowValue(inputs), context);
        } catch (error) {
            if (error instanceof AbortError || error instanceof FailableError || error instanceof HumanSuspendedError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            // Effects of an unexpected executor exception are unknown; only an explicit retry may replay it.
            throw new FailableError(message, {code: 'executor_failed', message, retryable: false, safeToReplay: false});
        } finally {
            acceptingEvents = false;
        }
        const outputs = copyWorkflowValue(this.extractOutputs(result.outputs, node.outputsTo));
        for (const [field, varName] of Object.entries(node.outputsTo)) {
            scope.write(varName, this.boundaryValue(outputs[field], node.outputs?.[field]));
        }
        return [node.next, outputs];
    }

    private async executeHuman(
        node: Extract<CFGNode, { type: 'call' }>,
        scope: ScopeManager,
        nodeRunId: string,
        inputs: Record<string, Value>,
    ): Promise<[string, Record<string, Value>]> {
        this.emit({event: 'node_running', ts: now(), node_run_id: nodeRunId});

        const pending = this.pendingHumanTask;
        this.pendingHumanTask = undefined;
        const resumedSubmission = this.pendingHumanSubmission;
        this.pendingHumanSubmission = undefined;
        const humanOutput = this.pendingHumanOutput;
        this.pendingHumanOutput = undefined;
        if (resumedSubmission) return this.applyHumanSubmission(node, scope, nodeRunId, resumedSubmission);
        if (humanOutput) return this.applyProvidedHumanOutput(node, scope, humanOutput);

        const request = pending ?? {
            version: 1 as const, taskId: crypto.randomUUID(), runId: this.cfg.runId, nodeId: node.id, nodeRunId,
            prompt: node.intent ?? '', inputs: JSON.parse(JSON.stringify(inputs)),
            outputs: Object.fromEntries(Object.keys(node.outputsTo).map(field => [field, node.outputs?.[field] ?? 'text' as const])),
            createdAt: new Date().toISOString(),
        };
        if (!pending) persistHumanTask(this.cfg.runDir, request);
        this.emit({
            event: 'node_suspended',
            ts: now(),
            node_run_id: nodeRunId,
            reason: 'waiting_human',
            task_id: request.taskId
        });
        this.cfg.runManager.update_status('suspended');
        this.writeSuspendedState();
        const controller = new AbortController();
        try {
            await this.cfg.humanExecutor?.present(JSON.parse(JSON.stringify(request)), {
                signal: controller.signal,
                submit: async submission => submission?.taskId === request.taskId
                    ? submitHumanTask(this.cfg.runDir, submission)
                    : {
                        status: 'stale',
                        taskId: submission?.taskId ?? '',
                        submissionId: submission?.submissionId ?? '',
                        message: 'Submission does not belong to this human task'
                    },
            });
        } catch (error) {
            this.emit({
                event: 'human_delivery_failed',
                ts: now(),
                node_run_id: nodeRunId,
                task_id: request.taskId,
                adapter_id: this.cfg.humanExecutor?.id ?? '',
                error: error instanceof Error ? error.message : String(error)
            });
            this.writeSuspendedState();
        } finally {
            controller.abort();
        }
        const submission = readHumanSubmission(this.cfg.runDir, request.taskId);
        if (!submission) throw new HumanSuspendedError(node.id);
        // Invalidate the recovery checkpoint before any downstream effects can run.
        this.cfg.runManager.update_status('running');
        return this.applyHumanSubmission(node, scope, nodeRunId, submission);
    }

    private applyHumanSubmission(node: Extract<CFGNode, { type: 'call' }>, scope: ScopeManager,
                                 nodeRunId: string, submission: HumanSubmission): [string, Record<string, Value>] {
        this.emit({
            event: 'human_submitted',
            ts: now(),
            node_run_id: nodeRunId,
            task_id: submission.taskId,
            submission_id: submission.submissionId
        });
        return this.applyProvidedHumanOutput(node, scope, submission.outputs);
    }

    private applyProvidedHumanOutput(
        node: Extract<CFGNode, { type: 'call' }>,
        scope: ScopeManager,
        humanOutput: Record<string, string>,
    ): [string, Record<string, Value>] {
        let outputs: Record<string, Value>;
        try {
            outputs = parseHumanOutputs(humanOutput, Object.fromEntries(Object.keys(node.outputsTo).map(field => [field, node.outputs?.[field] ?? 'text'])));
        } catch (error) {
            throw new AbortError((error as Error).message);
        }
        for (const [field, varName] of Object.entries(node.outputsTo)) scope.write(varName, this.boundaryValue(outputs[field], node.outputs?.[field]));
        return [node.next, outputs];
    }

    // ── BREAK / CONTINUE 内联 ─────────────────────────────────────────────────

    private handleBreak(scope: ScopeManager): string {
        const loopCtx = scope.find_loop_context();
        if (!loopCtx) throw new AbortError('BREAK outside loop');
        const nextExit = loopCtx.nextExit;
        scope.promote_and_pop_until_including(loopCtx);  // loop 内变量提升到父 scope
        return nextExit;
    }

    private async handleContinue(
        triggerNodeRunId: string,
        scope: ScopeManager,
        frame: Frame,
    ): Promise<string> {
        const loopCtx = scope.find_loop_context();
        if (!loopCtx) throw new AbortError('CONTINUE outside loop');
        scope.pop_above_loop_context();

        const forNode = frame.nodes[loopCtx.loopNodeId];
        let stepWrites: Record<string, Value> = {};
        let conditionResult: boolean;
        let next: string;

        if (forNode.type === 'for') {
            for (const {var: v, expr} of forNode.step) {
                const val = await this.evalExpression(expr, scope.visible_vars());
                scope.write(v, val);
                setValueField(stepWrites, v, val);
            }
            conditionResult = Boolean(await this.evalExpression(forNode.condition, scope.visible_vars()));
            if (conditionResult) {
                scope.push({kind: 'iteration', vars: {}});
                next = loopCtx.nextBody;
            } else {
                const exit = loopCtx.nextExit;
                scope.promote_and_pop_until_including(loopCtx);  // loop 内变量提升到父 scope
                next = exit;
            }
        } else if (forNode.type === 'foreach') {
            loopCtx.cursor = (loopCtx.cursor ?? 0) + 1;
            const cursor = loopCtx.cursor;
            const array = loopCtx.array!;
            conditionResult = cursor < array.length;
            if (conditionResult) {
                scope.push({kind: 'iteration', vars: {}});
                scope.write(forNode.item_var, array[cursor]);
                if (forNode.index_var) scope.write(forNode.index_var, cursor);
                next = loopCtx.nextBody;
            } else {
                const exit = loopCtx.nextExit;
                scope.promote_and_pop_until_including(loopCtx);  // loop 内变量提升到父 scope
                next = exit;
            }
        } else {
            /* istanbul ignore next */
            throw new AbortError(`CONTINUE on non-loop node: ${loopCtx.loopNodeId}`);
        }

        this.emit({
            event: 'continue_inline', ts: now(),
            trigger_node_run_id: triggerNodeRunId,
            loop_node_id: loopCtx.loopNodeId,
            step_results: stepWrites,
            condition_result: conditionResult,
            next,
        });
        if (this.cfg.checkpointsEnabled) {
            this.emit({
                event: 'checkpoint', ts: now(),
                node_run_id: triggerNodeRunId,
                call_stack: this.serializeCallStack(),
                global_seq: this.globalSeq,
            });
        }
        return next;
    }

    // ── sub-ITT pop ────────────────────────────────────────────────────────────

    private popCallFrame(): void {
        const finished = this.callStack[this.callStack.length - 1];
        const subOutputs = this.extractOutputsFromFrame(finished);
        this.callStack.pop();
        this.emit({event: 'frame_pop', ts: now(), frame_id: finished.frameId, outputs: subOutputs});

        const parentFrame = this.callStack[this.callStack.length - 1];
        if (finished.returnContext) {
            for (const [subKey, parentVar] of Object.entries(finished.returnContext.outputsTo)) {
                if (!(subKey in subOutputs)) {
                    throw new AbortError(`Sub-ITT did not produce mapped output field: ${subKey}`);
                }
                parentFrame.scope.write(parentVar, subOutputs[subKey]);
            }
            const callNode = parentFrame.nodes[finished.returnContext.parentCallNodeId] as Extract<CFGNode, {
                type: 'call'
            }>;
            if (callNode.resultTo) parentFrame.scope.write(callNode.resultTo, subOutputs);
            const callNodeRunId = finished.callNodeRunId ?? 'unknown';
            this.emit({event: 'node_success', ts: now(), node_run_id: callNodeRunId, outputs: subOutputs});
            parentFrame.currentNode = callNode.next;

            // checkpoint after call node completes
            if (this.cfg.checkpointsEnabled) {
                this.emit({
                    event: 'checkpoint', ts: now(),
                    node_run_id: callNodeRunId,
                    call_stack: this.serializeCallStack(),
                    global_seq: this.globalSeq,
                });
            }
        }
    }

    // ── 辅助函数 ──────────────────────────────────────────────────────────────

    private loadITT(intentName: string): CFGITT {
        let itt = this.snapshots.get(intentName);
        if (!itt) this.snapshots.set(intentName, itt = readSnapshot(this.cfg.snapshotDir, intentName));
        return itt;
    }

    private isImpl(callee?: string): boolean {
        if (!callee) return false;
        try {
            return snapshotFile(this.cfg.snapshotDir, callee, '.itt.impl.json') !== undefined;
        } catch {
            return false;
        }
    }

    private generateNodeRunId(): string {
        const hex = this.globalSeq.toString(16).padStart(4, '0');
        this.globalSeq++;
        return `${this.cfg.runId}_${hex}`;
    }

    private restorePendingCall(cf: CheckpointFrame, copy: <T>(value: T) => T): Frame['pendingCall'] {
        const pending = cf.pending_call as unknown;
        if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) throw new AbortError('Invalid checkpoint pending call');
        const {node_id: nodeId, inputs} = pending as Record<string, unknown>;
        if (typeof nodeId !== 'string' || inputs === null || typeof inputs !== 'object' || Array.isArray(inputs))
            throw new AbortError('Invalid checkpoint pending call');
        assertWorkflowValue(inputs);
        return {nodeId, inputs: copy(inputs as Record<string, Value>)};
    }

    /** An on_failure handler whose normal flow reaches a loop's exit path runs outside that loop. */
    private unwindLoopsFor(frame: Frame, target: string): void {
        for (const loop of frame.scope.loop_contexts()) {
            const key = `${frame.intentName}\0${loop.loopNodeId}\0${target}`;
            let leaves = this.handlerLeavesLoop.get(key);
            if (leaves === undefined) {
                const outside = flowFrom(frame.nodes, loop.nextExit, loop.loopNodeId);
                leaves = [...flowFrom(frame.nodes, target, loop.loopNodeId)].some(id => outside.has(id));
                this.handlerLeavesLoop.set(key, leaves);
            }
            if (leaves) {
                frame.scope.promote_and_pop_until_including(loop);
                return;
            }
        }
    }

    private newFrameId(): string {
        return `${this.cfg.runId}_f${this.globalSeq}`;
    }

    private resolveExtensions(itt: CFGITT, parent: ExtensionState[], saved?: CheckpointFrame): ExtensionState[] {
        try {
            return saved
                ? this.extensions.restore(itt, saved.extension_state, parent, this.cfg.allowLegacyExtensionRestore)
                : this.extensions.derive(itt, parent);
        } catch (error) {
            this.cfg.runManager.update_status('aborted');
            throw new AbortError(`Runtime extension error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private boundaryValue(value: Value, kind?: ValueType, itt = this.loadITT(this.callStack.at(-1)!.intentName)): Value {
        return itt.expressionSemantics === 'plain-data' && (kind === 'file' || kind === 'dir') && isFileRef(value) ? value.path : value;
    }

    private evalExpression(expression: string, vars: Record<string, Value>): Promise<Value> {
        const itt = this.loadITT(this.callStack.at(-1)!.intentName);
        return this.cfg.evalEngine.eval(expression, vars, {fileReferences: itt.expressionSemantics === 'plain-data' ? 'data' : 'legacy-path'});
    }

    private async resolveInputsFrom(
        node: Extract<CFGNode, { type: 'call' }>,
        scope: ScopeManager,
    ): Promise<Record<string, Value>> {
        const inputs: Record<string, Value> = {};
        const vars = scope.visible_vars();
        for (const [paramName, ref] of Object.entries(node.inputsFrom)) {
            if (ref.startsWith('$')) {
                setValueField(inputs, paramName, scope.read(ref.slice(1)));
            } else {
                try {
                    setValueField(inputs, paramName, await this.evalExpression(ref, vars));
                } catch (e) {
                    if (e instanceof AbortError) throw e;
                    throw new AbortError(`Eval error for "${paramName}": ${String(e)}`);
                }
            }
        }
        assertWorkflowValue(inputs);
        return inputs;
    }

    private extractOutputs(
        resultOutputs: Record<string, Value>,
        outputsTo: Record<string, string>,
    ): Record<string, Value> {
        assertWorkflowValue(resultOutputs);
        const outputs: Record<string, Value> = {};
        for (const field of Object.keys(outputsTo)) {
            if (!Object.hasOwn(resultOutputs, field)) {
                throw new AbortError(`Executor did not produce field: ${field}`);
            }
            setValueField(outputs, field, resultOutputs[field]);
        }
        return outputs;
    }

    private extractOutputsFromFrame(frame: Frame): Record<string, Value> {
        const outputs: Record<string, Value> = {};
        if (!frame.returnContext) return outputs;
        const itt = this.loadITT(frame.intentName);
        if (itt.resultVar) return assertReturnValue(frame.scope.read(itt.resultVar), Object.keys(itt.outputs ?? {}));
        for (const [key, varName] of Object.entries(frame.returnContext.topLevelOutputs)) {
            try {
                setValueField(outputs, key, frame.scope.read(varName));
            } catch {
                // variable might not exist if sub-ITT has optional outputs
            }
        }
        return outputs;
    }

    private collectTopLevelOutputs(frame: Frame, itt: CFGITT): Record<string, Value> {
        if (itt.resultVar) return assertReturnValue(frame.scope.read(itt.resultVar), Object.keys(itt.outputs ?? {}));
        const outputs: Record<string, Value> = {};
        for (const [key, varName] of Object.entries(itt.outputs ?? {})) {
            setValueField(outputs, key, frame.scope.read(varName));  // throws AbortError if missing
        }
        return outputs;
    }

    private buildPendingInputs(node: CFGNode, scope: ScopeManager): Record<string, Value> {
        switch (node.type) {
            case 'assign':
                return {assignments: node.assignments as unknown as Value};
            case 'if':
                return {condition_expr: node.condition};
            case 'for': {
                const isFirst = !scope.has_loop_context(node.id);
                return {iteration: isFirst ? 'first' : 'subsequent', condition_expr: node.condition};
            }
            case 'foreach': {
                const isFirst = !scope.has_loop_context(node.id);
                return isFirst
                    ? {array_expr: node.array_expr, item_var: node.item_var, iteration: 'first'}
                    : {item_var: node.item_var, iteration: 'subsequent'};
            }
            case 'call':
                return {intent: node.intent ?? '', executor: node.executor};
            default:
                return {};
        }
    }

    private serializeCallStack(): CheckpointFrame[] {
        const copy = createStateCopier();
        return this.callStack.map(f => ({
            frame_id: f.frameId,
            intent_name: f.intentName,
            current_node: f.currentNode,
            ...(f.callNodeRunId !== undefined ? {call_node_run_id: f.callNodeRunId} : {}),
            scope_stack: f.scope.serialize(copy),
            extension_state: JSON.parse(JSON.stringify(f.extensions)),
            return_context: f.returnContext
                ? {parent_call_node_id: f.returnContext.parentCallNodeId, outputs_to: f.returnContext.outputsTo}
                : null,
            ...(f.pendingCall ? {pending_call: {node_id: f.pendingCall.nodeId, inputs: copy(f.pendingCall.inputs)}} : {}),
        }));
    }

    private writeSuspendedState(): void {
        this.emit({
            event: 'suspended_state',
            ts: now(),
            call_stack: this.serializeCallStack(),
            global_seq: this.globalSeq,
        });
    }

    private emitRunAbort(nodeRunId: string, reason: string): void {
        this.emit({event: 'run_abort', ts: now(), node_run_id: nodeRunId, reason});
        this.cfg.runManager.update_status('aborted');
    }

    private emit(ev: LogEvent): void {
        this.logger.append(ev);
        if (!this.cfg.onEvent) return;
        try {
            this.cfg.onEvent(createStateCopier()(ev));
        } catch { /* Observers cannot change run state. */
        }
    }
}

function now(): number {
    return Math.floor(Date.now() / 1000);
}

/** Nodes reachable through normal control edges from start, never entering stop. */
function flowFrom(nodes: Record<string, CFGNode>, start: string, stop: string): Set<string> {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length) {
        const id = pending.pop()!;
        if (id === stop || seen.has(id) || !Object.hasOwn(nodes, id)) continue;
        seen.add(id);
        const node = nodes[id];
        if (node.type === 'if') pending.push(node.next_true, node.next_false);
        else if (node.type === 'for' || node.type === 'foreach') pending.push(node.next_body, node.next_exit);
        else pending.push(node.next);
    }
    return seen;
}

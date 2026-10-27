import {decodeCheckpointStack} from './state-graph';
/**
 * Rehydrator — resume 时从 execution.jsonl 重建 SchedulerContext
 *
 * 核心原则：
 *   - 调度器只在主动退出前写 suspended_state 事件（完整帧栈 + global_seq）
 *   - 读 JSONL 最后一行，若是 suspended_state → 直接反序列化，无需扫描
 *   - 进程 crash 不支持 resume（JSONL 末尾无 suspended_state）
 */
import * as fs from 'fs';
import type {HumanSubmission, HumanTaskRequest} from '@openhilo/human-contracts';
import {readHumanSubmission, readHumanTask} from './human-tasks';
import * as path from 'path';
import type {Failure} from '@openhilo/ai-contracts';
import type {CheckpointFrame, PersistedLogEvent} from './types';

// ── 公开接口 ──────────────────────────────────────────────────────────────────

export type RehydrateResult =
    | {
    kind: 'ok';
    callStack: CheckpointFrame[];
    globalSeq: number;
    pendingHumanOutput?: Record<string, string>;
    humanNodeRunId?: string;
    pendingHumanSubmission?: HumanSubmission;
    pendingHumanTask?: HumanTaskRequest;
}
    | { kind: 'suspended_no_output'; nodeRunId: string }
    | { kind: 'no_suspended_state' }
    | { kind: 'unsafe_to_replay'; nodeRunId: string; failure: Failure };

// ── Rehydrator ────────────────────────────────────────────────────────────────

export class Rehydrator {
    private readonly jsonlPath: string;

    constructor(private readonly runDir: string) {
        this.jsonlPath = path.join(runDir, 'execution.jsonl');
    }

    /**
     * 重建运行状态。
     * @param humanOutput 若 human 节点已挂起，调用者传入的 human 输出 key=value map
     */
    rehydrate(humanOutput?: Record<string, string>, redeliverHuman = false, retryFailedNode?: string): RehydrateResult {
        const events = this.readJsonl();

        if (events.length === 0) {
            return {kind: 'no_suspended_state'};
        }

        // ── 1. 检查最后一行是否为 suspended_state ──────────────────────────────
        const lastEvent = events[events.length - 1];
        if (lastEvent.event !== 'suspended_state') {
            return {kind: 'no_suspended_state'};
        }

        if (retryFailedNode !== undefined) {
            const boundary = [...events].reverse().find(ev => ['run_failed', 'node_suspended', 'run_resume', 'run_start'].includes(ev.event));
            if (boundary?.event !== 'run_failed' || boundary.node_run_id !== retryFailedNode) {
                throw new Error('Failed step changed; reload the run before resuming');
            }
        }

        const suspendedState = lastEvent as Extract<PersistedLogEvent, { event: 'suspended_state' }>;
        const callStack = decodeCheckpointStack(suspendedState.call_stack);
        const globalSeq = suspendedState.global_seq;

        // ── 2. 检查是否有挂起的 human 节点（查找最近的 node_suspended 事件）──
        let suspendedNodeRunId: string | undefined;
        let humanTaskId: string | undefined;
        for (let i = events.length - 2; i >= 0; i--) {
            const ev = events[i];
            if (ev.event === 'node_suspended') {
                suspendedNodeRunId = ev.node_run_id;
                humanTaskId = ev.task_id;
                break;
            }
            // Only the current suspension's terminal failure controls replay. Older
            // handled failures must not prevent a later human operation from resuming.
            if (ev.event === 'run_failed') {
                if (ev.failure?.safeToReplay === false && retryFailedNode !== ev.node_run_id) {
                    return {kind: 'unsafe_to_replay', nodeRunId: ev.node_run_id, failure: ev.failure};
                }
                break;
            }
            if (ev.event === 'run_start' || ev.event === 'run_resume') break;
        }

        const pendingHumanSubmission = humanTaskId ? readHumanSubmission(this.runDir, humanTaskId) : undefined;
        const pendingHumanTask = redeliverHuman && humanTaskId ? readHumanTask(this.runDir, humanTaskId) : undefined;
        if (suspendedNodeRunId !== undefined && !humanOutput && !pendingHumanSubmission && !pendingHumanTask) {
            return {kind: 'suspended_no_output', nodeRunId: suspendedNodeRunId};
        }

        return {
            kind: 'ok',
            callStack,
            globalSeq,
            pendingHumanOutput: suspendedNodeRunId !== undefined ? humanOutput : undefined,
            ...(pendingHumanSubmission ? {pendingHumanSubmission} : {}),
            ...(pendingHumanTask ? {pendingHumanTask} : {}),
            ...(suspendedNodeRunId !== undefined ? {humanNodeRunId: suspendedNodeRunId} : {}),
        };
    }

    // ── 私有辅助 ──────────────────────────────────────────────────────────────

    private readJsonl(): PersistedLogEvent[] {
        if (!fs.existsSync(this.jsonlPath)) return [];
        const content = fs.readFileSync(this.jsonlPath, 'utf-8').trim();
        if (!content) return [];
        const events: PersistedLogEvent[] = [];
        const lines = content.split('\n').filter(line => line.trim());
        for (const [index, line] of lines.entries()) {
            if (!line.trim()) continue;  // skip whitespace-only lines
            try {
                const event = JSON.parse(line);
                if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
                    if (index === lines.length - 1) return [];
                    continue;
                }
                events.push(event as PersistedLogEvent);
            } catch {
                // An incomplete final write may follow a resumed execution. Never fall
                // back to an older suspension and replay work with unknown effects.
                if (index === lines.length - 1) return [];
                // Preserve legacy tolerance for malformed historical lines only.
            }
        }
        return events;
    }
}

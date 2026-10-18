import {diagnosticJson} from './diagnostic-json';
import {encodeStateGraph} from './state-graph';
import {assertWorkflowValue, setValueField} from './workflow-value';
/**
 * Logger — JSONL 事件追加写 + 引用语义序列化（架构 §2.10）
 *
 * 引用语义规则：
 *   - boolean / number：始终内联
 *   - text / json < 64KB：内联；>= 64KB：写 io_records，记 file_ref
 *   - file / dir：始终 file_ref
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {isFileRef, type LogEvent, type PersistedLogEvent, type Value} from './types';

const INLINE_THRESHOLD_BYTES = 64 * 1024;  // 64KB

export class Logger {
    private jsonlPath: string;

    constructor(
        private readonly runDir: string,
        private readonly runId: string,
    ) {
        this.jsonlPath = path.join(runDir, 'execution.jsonl');
    }

    /** 初始化：创建空 execution.jsonl */
    init(): void {
        fs.writeFileSync(this.jsonlPath, '', 'utf-8');
    }

    /**
     * 追加一条事件到 execution.jsonl。
     * outputs/inputs 中的大值自动应用引用语义。
     */
    append(event: LogEvent): void {
        const serialized = this.serializeEvent(event);
        fs.appendFileSync(this.jsonlPath, JSON.stringify(serialized) + '\n', 'utf-8');
    }

    /**
     * 将已解析 inputs 写入 io_records/<node_run_id>_inputs.json（调试用）。
     */
    write_inputs_record(nodeRunId: string, inputs: Record<string, Value>): void {
        assertWorkflowValue(inputs);
        const filePath = path.join(this.runDir, 'io_records', `${nodeRunId}_inputs.json`);
        fs.writeFileSync(filePath, diagnosticJson(inputs, INLINE_THRESHOLD_BYTES).text, 'utf-8');
    }

    // ── 引用语义序列化 ─────────────────────────────────────────────────────────

    private serializeEvent(event: LogEvent): PersistedLogEvent {
        if (event.event === 'checkpoint' || event.event === 'suspended_state') {
            for (const frame of event.call_stack) for (const scope of frame.scope_stack) {
                assertWorkflowValue(scope.vars);
                if (scope.kind === 'loop-context' && scope.array !== undefined) assertWorkflowValue(scope.array);
            }
            return {...event, call_stack: encodeStateGraph(event.call_stack as unknown as Value)};
        }
        if (event.event === 'continue_inline') assertWorkflowValue(event.step_results);
        // 只处理含 inputs/outputs 的事件
        const ev = {...event} as Record<string, unknown>;
        if (event.event === 'continue_inline') {
            ev.step_results = this.serializeValueMap(event.step_results, event.trigger_node_run_id, 'step');
        }

        if (ev.inputs && typeof ev.inputs === 'object') {
            ev.inputs = this.serializeValueMap(
                ev.inputs as Record<string, Value>,
                (ev.node_run_id as string) ?? 'unknown',
                'inputs',
            );
        }
        if (ev.outputs && typeof ev.outputs === 'object') {
            ev.outputs = this.serializeValueMap(
                ev.outputs as Record<string, Value>,
                (ev.node_run_id as string) ?? 'unknown',
                'output',
            );
        }
        if (ev.vars && typeof ev.vars === 'object') {
            ev.vars = this.serializeValueMap(
                ev.vars as Record<string, Value>,
                'sys',
                'vars',
            );
        }

        return ev as unknown as LogEvent;
    }

    private serializeValueMap(
        map: Record<string, Value>,
        nodeRunId: string,
        prefix: string,
    ): Record<string, Value> {
        assertWorkflowValue(map);
        const result: Record<string, Value> = {};
        for (const [key, val] of Object.entries(map)) {
            setValueField(result, key, this.serializeValue(val, nodeRunId, key, prefix));
        }
        return result;
    }

    private serializeValue(
        val: Value,
        nodeRunId: string,
        key: string,
        prefix: string,
    ): Value {
        // boolean / number：始终内联
        if (typeof val === 'boolean' || typeof val === 'number' || val === null) {
            return val;
        }

        // 已是 file_ref：直接保留
        if (isFileRef(val)) {
            return val;
        }

        // string：按大小决定
        if (typeof val === 'string') {
            const byteLen = Buffer.byteLength(val, 'utf-8');
            if (byteLen < INLINE_THRESHOLD_BYTES) {
                return val;
            }
            return this.writeToIoRecord(val, nodeRunId, `${prefix}_${key}`, '.txt');
        }

        // object（json 类型）：序列化后按大小决定
        const encoded = diagnosticJson(val, INLINE_THRESHOLD_BYTES);
        const serialized = encoded.text;
        const byteLen = Buffer.byteLength(serialized, 'utf-8');
        if (!encoded.graph && byteLen < INLINE_THRESHOLD_BYTES) {
            return val;
        }
        return this.writeToIoRecord(serialized, nodeRunId, `${prefix}_${key}`, encoded.graph ? '.graph.json' : '.json');
    }

    private writeToIoRecord(
        content: string,
        nodeRunId: string,
        suffix: string,
        ext: string,
    ): { type: 'file_ref'; path: string; hash: string; mtime: number } {
        const filename = `${nodeRunId}_${suffix}${ext}`;
        const relPath = path.join('io_records', filename);
        const absPath = path.join(this.runDir, relPath);
        fs.writeFileSync(absPath, content, 'utf-8');
        const hash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
        const mtime = Math.floor(Date.now() / 1000);
        return {type: 'file_ref', path: relPath, hash, mtime};
    }
}

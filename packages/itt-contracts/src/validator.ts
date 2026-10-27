import {isInputShape, validOutputShapes} from './run-inputs';
import {parseAiSelection} from './ai-selection';
/**
 * Validator — ITT 静态验证（见 docs/execution-model.md）
 *
 * Errors（阻断）：
 *   - ITT / nodes / 节点不是普通对象；version 不是 2；节点 type 未知；节点 id 与 key 不一致
 *   - entry 节点不存在
 *   - 节点 ID 与保留字重名（END、BREAK、CONTINUE、ABORT）
 *   - next/next_true/next_false/next_body/next_exit/on_failure 不是字符串
 *   - 任一节点（含不可达节点）的 next* 引用不存在的节点（合法保留字除外）
 *   - ABORT 出现在 next/next_true/next_false/next_body/next_exit（只允许在 on_failure）
 *   - BREAK/CONTINUE 在循环外使用（含循环 next_exit 之后的路径）
 *   - on_failure 引用不存在的节点（'ABORT' 除外）
 *   - call.executor 不在 ai/code/human/sys/intent 中
 *   - call(executor=code) 缺少 script 字段
 *   - inputs（ITT 与 call 节点）的 kind 不是 ValueType 或 shape 不合法
 *   - call.inputsFrom 的 key 不全在 inputs 中（若 inputs 有声明）
 *   - call.outputsTo 的 key 不全在 outputs ∪ {stdout,stderr,exit_code} 中
 *   - call.outputs 的 key 包含保留输出名 stdout/stderr/exit_code
 *
 * Warnings（不阻断）：
 *   - 从 entry 不可达的孤立节点
 */

import type {CallNode, CFGITT, CFGNode} from './index';

const RESERVED_WORDS = new Set(['END', 'BREAK', 'CONTINUE', 'ABORT']);
const LOOP_TYPES = new Set(['for', 'foreach']);
const NODE_TYPES = new Set(['assign', 'if', 'for', 'foreach', 'call']);
const EXECUTORS = new Set(['ai', 'code', 'human', 'sys', 'intent']);
const VALUE_TYPES = new Set(['text', 'number', 'boolean', 'json', 'file', 'dir']);

/** Well-known output names for executor=code (reserved; cannot appear in node.outputs keys) */
const CODE_EXECUTOR_RESERVED_OUTPUTS = new Set(['stdout', 'stderr', 'exit_code']);

type NamedRef = { ref: string; field: string; isOnFailure: boolean };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function refFields(type: string): string[] {
    switch (type) {
        case 'if': return ['next_true', 'next_false'];
        case 'for': case 'foreach': return ['next_body', 'next_exit'];
        default: return ['next'];
    }
}

export interface ValidationResult {
    errors: string[];
    warnings: string[];
}

export class Validator {
    validate(itt: CFGITT): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];
        if (!isPlainObject(itt)) return {errors: ['ITT must be an object'], warnings};
        // Pre-rename v2 graphs recorded the version as the string '2.0'.
        if (itt.version !== 2 && (itt.version as unknown) !== '2.0')
            errors.push(`Unsupported ITT version ${JSON.stringify(itt.version) ?? 'undefined'}; expected 2`);
        if (!isPlainObject(itt.nodes)) {
            errors.push('ITT "nodes" must be an object');
            return {errors, warnings};
        }
        const nodes = itt.nodes as Record<string, unknown>;
        const nodeIds = new Set(Object.keys(nodes));
        if (itt.expressionSemantics !== undefined && itt.expressionSemantics !== 'plain-data')
            errors.push('Unsupported expressionSemantics; expected plain-data');
        if (itt.resultVar !== undefined && (typeof itt.resultVar !== 'string' || !itt.resultVar.trim()))
            errors.push('resultVar must be a nonempty scope variable name');
        this.validateInputs(itt.inputs, 'ITT input', errors);

        // ── 1. entry 节点存在 ────────────────────────────────────────────────────
        const entry = typeof itt.entry === 'string' && nodeIds.has(itt.entry) ? itt.entry : undefined;
        if (entry === undefined) {
            errors.push(`Entry node "${String(itt.entry)}" does not exist`);
        }

        // ── 2. 节点 ID 不与保留字重名 ─────────────────────────────────────────
        for (const id of nodeIds) {
            if (RESERVED_WORDS.has(id)) {
                errors.push(`Node ID "${id}" conflicts with reserved word`);
            }
        }

        // ── 3. 节点结构校验；结构无效的节点不参与后续检查 ─────────────────────
        const valid = new Map<string, CFGNode>();
        for (const id of nodeIds) {
            const node = this.validateNodeShape(id, nodes[id], errors);
            if (node) valid.set(id, node);
        }

        // ── 4. 每个节点的 next 引用校验 + BREAK/CONTINUE 循环上下文检查 ───────
        for (const [id, node] of valid) this.validateRefs(id, node, nodeIds, errors);
        if (entry !== undefined) this.validateLoopContext(entry, valid, errors);

        // ── 5. call 节点 field-level 校验 ────────────────────────────────────
        for (const [nodeId, node] of valid) {
            if (Object.hasOwn(node, 'aiSelection')) {
                try {
                    if (node.type !== 'call' || node.executor !== 'ai') throw new Error('AI selection requires an AI call node');
                    parseAiSelection(node.aiSelection);
                    if (node.model !== undefined) throw new Error('AI selection cannot be combined with legacy model/profile');
                } catch (error) { errors.push(`Node ${nodeId}: ${(error as Error).message}`); }
            }
            if (node.type === 'call') {
                this.validateCallNode(nodeId, node as CallNode, errors);
                if (node.resultTo !== undefined && (node.executor !== 'intent' || typeof node.resultTo !== 'string' || !node.resultTo.trim()))
                    errors.push(`Call node "${nodeId}" resultTo requires executor intent and a nonempty scope variable name`);
            }
        }

        // ── 6. 孤立节点警告（从 entry 不可达）────────────────────────────────
        const reachable = this.findReachable(entry, nodeIds, valid);
        for (const id of nodeIds) {
            if (!reachable.has(id)) {
                warnings.push(`Node "${id}" is unreachable from entry`);
            }
        }

        return {errors, warnings};
    }

    // ── 节点结构校验 ──────────────────────────────────────────────────────────

    private validateNodeShape(id: string, node: unknown, errors: string[]): CFGNode | undefined {
        if (!isPlainObject(node)) {
            errors.push(`Node "${id}" must be an object`);
            return undefined;
        }
        if (typeof node.type !== 'string' || !NODE_TYPES.has(node.type)) {
            errors.push(`Node "${id}" has unknown type ${JSON.stringify(node.type) ?? 'undefined'}`);
            return undefined;
        }
        let ok = true;
        if (node.id !== id) {
            errors.push(`Node "${id}" has mismatched id ${JSON.stringify(node.id) ?? 'undefined'}`);
            ok = false;
        }
        const fields = [...refFields(node.type), ...(node.type === 'call' && node.on_failure !== undefined ? ['on_failure'] : [])];
        for (const field of fields) {
            if (typeof node[field] !== 'string' || !node[field]) {
                errors.push(`Node "${id}" field "${field}" must be a nonempty node ID string`);
                ok = false;
            }
        }
        if (node.type === 'call' && (typeof node.executor !== 'string' || !EXECUTORS.has(node.executor))) {
            errors.push(`Call node "${id}" has unsupported executor ${JSON.stringify(node.executor) ?? 'undefined'}`);
            ok = false;
        }
        return ok ? node as unknown as CFGNode : undefined;
    }

    private validateInputs(inputs: unknown, label: string, errors: string[]): void {
        if (inputs === undefined) return;
        if (!isPlainObject(inputs)) {
            errors.push(`${label}s must be an object`);
            return;
        }
        for (const [name, definition] of Object.entries(inputs)) {
            if (!isPlainObject(definition)) {
                errors.push(`${label} "${name}" must be an object`);
                continue;
            }
            if (typeof definition.kind !== 'string' || !VALUE_TYPES.has(definition.kind))
                errors.push(`${label} "${name}" has unsupported kind ${JSON.stringify(definition.kind) ?? 'undefined'}`);
            if (definition.shape !== undefined && !isInputShape(definition.shape))
                errors.push(`${label} "${name}" has an invalid shape`);
        }
    }

    // ── call 节点字段校验 ─────────────────────────────────────────────────────

    private validateCallNode(
        nodeId: string,
        node: CallNode,
        errors: string[],
    ): void {
        this.validateInputs(node.inputs, `Call node "${nodeId}" input`, errors);
        if (node.outputs !== undefined) {
            if (!isPlainObject(node.outputs)) errors.push(`Call node "${nodeId}" outputs must be an object`);
            else for (const [key, kind] of Object.entries(node.outputs)) {
                if (typeof kind !== 'string' || !VALUE_TYPES.has(kind))
                    errors.push(`Call node "${nodeId}" output "${key}" has unsupported type ${JSON.stringify(kind) ?? 'undefined'}`);
            }
        }
        if (node.outputShapes !== undefined && (node.executor !== 'ai' || !validOutputShapes(node.outputs ?? {}, node.outputShapes)))
            errors.push(`Call node ${nodeId}: invalid AI output shapes`);
        if (node.executor === 'intent' && !node.callee) {
            errors.push(`Call node "${nodeId}" has executor="intent" but is missing required "callee" field`);
        }

        // executor=code must have script field
        if (node.executor === 'code' && !node.script) {
            errors.push(`Call node "${nodeId}" has executor="code" but is missing required "script" field`);
        }

        // outputs keys must not include reserved output names
        if (node.outputs) {
            for (const key of Object.keys(node.outputs)) {
                if (CODE_EXECUTOR_RESERVED_OUTPUTS.has(key)) {
                    errors.push(
                        `Call node "${nodeId}" declares reserved output name "${key}" in "outputs" — ` +
                        `"stdout", "stderr", and "exit_code" are reserved for code executor results`,
                    );
                }
            }
        }

        // inputsFrom keys must all be in inputs (if inputs is declared)
        if (node.inputs && node.inputsFrom) {
            const declaredInputKeys = new Set(Object.keys(node.inputs));
            for (const key of Object.keys(node.inputsFrom)) {
                if (!declaredInputKeys.has(key)) {
                    errors.push(
                        `Call node "${nodeId}" inputsFrom key "${key}" is not declared in "inputs"`,
                    );
                }
            }
        }

        // outputsTo keys must all be in outputs ∪ {stdout,stderr,exit_code}
        if (node.outputsTo) {
            const declaredOutputKeys = new Set(Object.keys(node.outputs ?? {}));
            // For code executor, also allow the three well-known stream outputs
            const allowedOutputKeys =
                node.executor === 'code'
                    ? new Set([...declaredOutputKeys, ...CODE_EXECUTOR_RESERVED_OUTPUTS])
                    : declaredOutputKeys;

            for (const key of Object.keys(node.outputsTo)) {
                if (!allowedOutputKeys.has(key)) {
                    errors.push(
                        `Call node "${nodeId}" outputsTo key "${key}" is not declared in "outputs"` +
                        (node.executor === 'code' ? ' or well-known code outputs (stdout/stderr/exit_code)' : ''),
                    );
                }
            }
        }
    }

    // ── 引用校验 ──────────────────────────────────────────────────────────────

    private validateRefs(nodeId: string, node: CFGNode, nodeIds: Set<string>, errors: string[]): void {
        for (const {ref, field, isOnFailure} of this.getNodeNamedRefs(node)) {
            // ABORT is only valid in on_failure
            if (ref === 'ABORT') {
                if (!isOnFailure) {
                    errors.push(
                        `Node "${nodeId}" uses ABORT in field "${field}" — ABORT is only valid as an on_failure value`,
                    );
                }
                continue;
            }
            if (RESERVED_WORDS.has(ref)) continue;
            if (!nodeIds.has(ref)) {
                errors.push(`Node "${nodeId}" references non-existent node "${ref}"`);
            }
        }
    }

    /**
     * Iterative traversal from entry with a stack of enclosing loop IDs. A loop's
     * next_body runs inside that loop; its next_exit runs in the enclosing context.
     * Reaching a loop already on the stack (the back edge) discards inner loops.
     */
    private validateLoopContext(entry: string, nodes: Map<string, CFGNode>, errors: string[]): void {
        const reported = new Set<string>();
        const visited = new Set<string>();
        const pending: Array<[string, readonly string[]]> = [[entry, []]];
        while (pending.length > 0) {
            const [nodeId, loops] = pending.pop()!;
            const visitKey = [nodeId, ...loops].join('\0');
            if (visited.has(visitKey)) continue;
            visited.add(visitKey);
            const node = nodes.get(nodeId);
            if (!node) continue;

            let enclosing = loops, body = loops;
            if (LOOP_TYPES.has(node.type)) {
                const at = loops.indexOf(nodeId);
                enclosing = at < 0 ? loops : loops.slice(0, at);
                body = [...enclosing, nodeId];
            }
            for (const {ref, field} of this.getNodeNamedRefs(node)) {
                const context = field === 'next_body' ? body : enclosing;
                if (ref === 'BREAK' || ref === 'CONTINUE') {
                    const key = `${nodeId}\0${field}`;
                    if (context.length === 0 && !reported.has(key)) {
                        reported.add(key);
                        errors.push(`${ref} used outside of a loop context (at node "${nodeId}")`);
                    }
                } else if (nodes.has(ref)) {
                    pending.push([ref, context]);
                }
            }
        }
    }

    private getNodeNamedRefs(node: CFGNode): NamedRef[] {
        const refs: NamedRef[] = refFields(node.type).map(field => ({
            ref: (node as unknown as Record<string, string>)[field],
            field,
            isOnFailure: false,
        }));
        if (node.type === 'call' && node.on_failure !== undefined) {
            refs.push({ref: node.on_failure, field: 'on_failure', isOnFailure: true});
        }
        return refs;
    }

    // ── 可达性分析 ────────────────────────────────────────────────────────────

    private findReachable(entry: string | undefined, nodeIds: Set<string>, nodes: Map<string, CFGNode>): Set<string> {
        const reachable = new Set<string>();
        if (entry === undefined) return reachable;
        const queue = [entry];
        reachable.add(entry);
        for (let index = 0; index < queue.length; index++) {
            const node = nodes.get(queue[index]);
            if (!node) continue;
            for (const {ref} of this.getNodeNamedRefs(node)) {
                if (RESERVED_WORDS.has(ref) || reachable.has(ref) || !nodeIds.has(ref)) continue;
                reachable.add(ref);
                queue.push(ref);
            }
        }
        return reachable;
    }
}

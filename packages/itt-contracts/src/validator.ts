import {validOutputShapes} from './run-inputs';
import {parseAiSelection} from './ai-selection';
/**
 * Validator — ITT 静态验证（架构 §2.4）
 *
 * Errors（阻断）：
 *   - entry 节点不存在
 *   - 节点 ID 与保留字重名（END、BREAK、CONTINUE、ABORT）
 *   - next/next_true/next_false/next_body/next_exit 引用的节点不存在（合法保留字除外）
 *   - ABORT 出现在 next/next_true/next_false/next_body/next_exit（只允许在 on_failure）
 *   - BREAK/CONTINUE 在循环外使用
 *   - on_failure 引用不存在的节点（'ABORT' 除外）
 *   - call(executor=code) 缺少 script 字段
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

/** Well-known output names for executor=code (reserved; cannot appear in node.outputs keys) */
const CODE_EXECUTOR_RESERVED_OUTPUTS = new Set(['stdout', 'stderr', 'exit_code']);

export interface ValidationResult {
    errors: string[];
    warnings: string[];
}

export class Validator {
    validate(itt: CFGITT): ValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];
        const nodeIds = new Set(Object.keys(itt.nodes));
        if (itt.expressionSemantics !== undefined && itt.expressionSemantics !== 'plain-data')
            errors.push('Unsupported expressionSemantics; expected plain-data');
        if (itt.resultVar !== undefined && (typeof itt.resultVar !== 'string' || !itt.resultVar.trim()))
            errors.push('resultVar must be a nonempty scope variable name');

        // ── 1. entry 节点存在 ────────────────────────────────────────────────────
        if (!nodeIds.has(itt.entry)) {
            errors.push(`Entry node "${itt.entry}" does not exist`);
        }

        // ── 2. 节点 ID 不与保留字重名 ─────────────────────────────────────────
        for (const id of nodeIds) {
            if (RESERVED_WORDS.has(id)) {
                errors.push(`Node ID "${id}" conflicts with reserved word`);
            }
        }

        // ── 3. next 引用校验 + BREAK/CONTINUE 循环上下文检查 ─────────────────
        this.validateRefs(itt, nodeIds, errors);

        // ── 4. call 节点 field-level 校验 ────────────────────────────────────
        for (const [nodeId, node] of Object.entries(itt.nodes)) {
            if (Object.hasOwn(node, 'aiSelection')) {
                try {
                    if (node.type !== 'call' || node.executor !== 'ai') throw new Error('AI selection requires an AI call node');
                    parseAiSelection(node.aiSelection);
                    if (node.model !== undefined) throw new Error('AI selection cannot be combined with legacy model/profile');
                } catch (error) { errors.push(`Node ${nodeId}: ${(error as Error).message}`); }
            }
            if (node.type === 'call') {
                this.validateCallNode(nodeId, node as CallNode, nodeIds, errors);
                if (node.resultTo !== undefined && (node.executor !== 'intent' || typeof node.resultTo !== 'string' || !node.resultTo.trim()))
                    errors.push(`Call node "${nodeId}" resultTo requires executor intent and a nonempty scope variable name`);
            }
        }

        // ── 5. 孤立节点警告（从 entry 不可达）────────────────────────────────
        const reachable = this.findReachable(itt);
        for (const id of nodeIds) {
            if (!reachable.has(id)) {
                warnings.push(`Node "${id}" is unreachable from entry`);
            }
        }

        return {errors, warnings};
    }

    // ── call 节点字段校验 ─────────────────────────────────────────────────────

    private validateCallNode(
        nodeId: string,
        node: CallNode,
        nodeIds: Set<string>,
        errors: string[],
    ): void {
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
                        `"stdout", "stderr", and "exit_code" are reserved (code-executor-abi §2)`,
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

    private validateRefs(itt: CFGITT, nodeIds: Set<string>, errors: string[]): void {
        // Build a control-flow context to detect BREAK/CONTINUE outside loops
        // We'll do a DFS and track whether we're inside a loop
        const visited = new Set<string>();
        this.dfsValidate(itt.entry, itt.nodes, nodeIds, errors, visited, false);
    }

    private dfsValidate(
        nodeId: string,
        nodes: Record<string, CFGNode>,
        nodeIds: Set<string>,
        errors: string[],
        visited: Set<string>,
        inLoop: boolean,
    ): void {
        const visitKey = `${nodeId}|${inLoop ? '1' : '0'}`;
        if (visited.has(visitKey)) return;
        visited.add(visitKey);

        const node = nodes[nodeId];
        if (!node) return;

        const isLoop = LOOP_TYPES.has(node.type);
        const childInLoop = inLoop || isLoop;

        // Validate each ref with its field context
        const namedRefs = this.getNodeNamedRefs(node);
        for (const {ref, field, isOnFailure} of namedRefs) {
            // ABORT is only valid in on_failure
            if (ref === 'ABORT') {
                if (!isOnFailure) {
                    errors.push(
                        `Node "${nodeId}" uses ABORT in field "${field}" — ABORT is only valid as an on_failure value (ts-subset-spec §3)`,
                    );
                }
                continue;
            }

            if (ref === 'END') continue;

            if (ref === 'BREAK' || ref === 'CONTINUE') {
                if (!inLoop) {
                    errors.push(`${ref} used outside of a loop context (at node "${nodeId}")`);
                }
                continue;
            }

            if (!nodeIds.has(ref)) {
                errors.push(`Node "${nodeId}" references non-existent node "${ref}"`);
                continue;
            }
            this.dfsValidate(ref, nodes, nodeIds, errors, visited, childInLoop);
        }
    }

    private getNodeNamedRefs(node: CFGNode): Array<{ ref: string; field: string; isOnFailure: boolean }> {
        switch (node.type) {
            case 'assign':
                return [{ref: node.next, field: 'next', isOnFailure: false}];
            case 'if':
                return [
                    {ref: node.next_true, field: 'next_true', isOnFailure: false},
                    {ref: node.next_false, field: 'next_false', isOnFailure: false},
                ];
            case 'for':
                return [
                    {ref: node.next_body, field: 'next_body', isOnFailure: false},
                    {ref: node.next_exit, field: 'next_exit', isOnFailure: false},
                ];
            case 'foreach':
                return [
                    {ref: node.next_body, field: 'next_body', isOnFailure: false},
                    {ref: node.next_exit, field: 'next_exit', isOnFailure: false},
                ];
            case 'call': {
                const refs: Array<{ ref: string; field: string; isOnFailure: boolean }> = [
                    {ref: node.next, field: 'next', isOnFailure: false},
                ];
                if (node.on_failure) {
                    refs.push({ref: node.on_failure, field: 'on_failure', isOnFailure: true});
                }
                return refs;
            }
        }
    }

    // Legacy helper used by findReachable — returns only the traversable refs (no ABORT/reserved)
    private getNodeRefs(node: CFGNode): string[] {
        return this.getNodeNamedRefs(node)
            .map((r) => r.ref)
            .filter((r) => r !== 'END' && r !== 'BREAK' && r !== 'CONTINUE' && r !== 'ABORT');
    }

    // ── 可达性分析 ────────────────────────────────────────────────────────────

    private findReachable(itt: CFGITT): Set<string> {
        const reachable = new Set<string>();
        const queue = [itt.entry];
        while (queue.length > 0) {
            const id = queue.shift()!;
            if (reachable.has(id)) continue;
            reachable.add(id);
            const node = itt.nodes[id];
            if (!node) continue;
            for (const ref of this.getNodeRefs(node)) {
                if (!reachable.has(ref)) queue.push(ref);
            }
        }
        return reachable;
    }
}

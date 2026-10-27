import {adoptWorkflowValue, assertWorkflowValue, createStateCopier, setValueField} from './workflow-value';
/**
 * ScopeManager — scope_stack 全部操作
 *
 * scope_stack 是一个层栈，每一层是 BaseScope | LoopContextScope | IterationScope。
 * 读取：从最内层向外搜索；写入：更新已存在的层（任意层），否则写入最内层。
 * ITT_WORKSPACE 变量特殊：存绝对路径，写保护（不可覆写）。
 */
import {AbortError, type LoopContextScope, type Scope, type ScopeStackSnapshot, type Value,} from './types';

export class ScopeManager {
    private stack: Scope[] = [];

    // ── 栈操作 ────────────────────────────────────────────────────────────────

    push(scope: Scope): void {
        this.validateScope(scope);
        this.stack.push({...scope, vars: {...scope.vars}});
    }

    pop(): Scope {
        if (this.stack.length <= 1) {
            throw new AbortError('Cannot pop the last remaining scope layer');
        }
        return this.stack.pop()!;
    }

    peek(): Scope {
        return this.stack[this.stack.length - 1];
    }

    // ── 读写 ──────────────────────────────────────────────────────────────────

    /**
     * 从最内层向外搜索变量。未找到 → AbortError。
     */
    read(varName: string): Value {
        for (let i = this.stack.length - 1; i >= 0; i--) {
            const scope = this.stack[i];
            if (Object.prototype.hasOwnProperty.call(scope.vars, varName)) {
                return scope.vars[varName];
            }
        }
        throw new AbortError(`Variable not found: ${varName}`);
    }

    /**
     * 写入变量：
     * - ITT_WORKSPACE 已存在时 → AbortError（写保护）
     * - 变量已在某层存在 → 原地更新该层
     * - 变量不存在 → 写入最内层
     */
    write(varName: string, value: Value): void {
        adoptWorkflowValue(value);

        // ITT_WORKSPACE 写保护
        if (varName === 'ITT_WORKSPACE') {
            for (let i = this.stack.length - 1; i >= 0; i--) {
                if (Object.prototype.hasOwnProperty.call(this.stack[i].vars, varName)) {
                    throw new AbortError('ITT_WORKSPACE is write-protected and cannot be overwritten');
                }
            }
            // 首次写入（初始化时允许）
            setValueField(this.stack[this.stack.length - 1].vars, varName, value);
            return;
        }

        // 查找已存在该变量的层（从内到外），原地更新
        for (let i = this.stack.length - 1; i >= 0; i--) {
            if (Object.prototype.hasOwnProperty.call(this.stack[i].vars, varName)) {
                setValueField(this.stack[i].vars, varName, value);
                return;
            }
        }

        // 未找到 → 写入最内层
        setValueField(this.stack[this.stack.length - 1].vars, varName, value);
    }

    // ── loop-context 操作 ─────────────────────────────────────────────────────

    has_loop_context(nodeId: string): boolean {
        return this.stack.some(
            s => s.kind === 'loop-context' && (s as LoopContextScope).loopNodeId === nodeId
        );
    }

    /**
     * 返回最内层 loop-context scope，无则返回 null。
     */
    find_loop_context(): LoopContextScope | null {
        for (let i = this.stack.length - 1; i >= 0; i--) {
            if (this.stack[i].kind === 'loop-context') {
                return this.stack[i] as LoopContextScope;
            }
        }
        return null;
    }

    /** 所有 loop-context scope，外层在前。 */
    loop_contexts(): LoopContextScope[] {
        return this.stack.filter((s): s is LoopContextScope => s.kind === 'loop-context');
    }

    /**
     * 按 nodeId 精确查找 loop-context scope。未找到 → AbortError。
     */
    loop_context(nodeId: string): LoopContextScope {
        for (let i = this.stack.length - 1; i >= 0; i--) {
            const s = this.stack[i];
            if (s.kind === 'loop-context' && (s as LoopContextScope).loopNodeId === nodeId) {
                return s as LoopContextScope;
            }
        }
        throw new AbortError(`Loop context not found for node: ${nodeId}`);
    }

    // ── BREAK / CONTINUE scope 操作 ───────────────────────────────────────────

    /**
     * 迭代间 pop：弹出 iteration scope，并将其 vars 提升到父 scope（loop-context 或 base）。
     * 顶层必须是 iteration scope，否则 AbortError。
     */
    pop_iteration_with_promotion(): void {
        const top = this.stack[this.stack.length - 1];
        if (top.kind !== 'iteration') {
            throw new AbortError('Expected iteration scope on top of stack');
        }
        this.stack.pop();
        const parent = this.stack[this.stack.length - 1];
        Object.defineProperties(parent.vars, Object.getOwnPropertyDescriptors(top.vars));
    }

    /**
     * 循环退出 / BREAK 用：将 loopCtx 及其上所有层的 vars 提升到父 scope，再移除。
     * 与 pop_until_including 的区别：提升（不丢弃）loop 内积累的变量。
     */
    promote_and_pop_until_including(loopCtx: LoopContextScope): void {
        const idx = this.stack.indexOf(loopCtx);
        if (idx === -1) {
            throw new AbortError(`Loop context not found in stack: ${loopCtx.loopNodeId}`);
        }
        if (idx === 0) {
            throw new AbortError('Cannot pop the last remaining scope layer');
        }
        // Collect all vars from loopCtx and above, promote to parent
        const parent = this.stack[idx - 1];
        for (let i = idx; i < this.stack.length; i++) {
            Object.defineProperties(parent.vars, Object.getOwnPropertyDescriptors(this.stack[i].vars));
        }
        this.stack.splice(idx);
    }

    /**
     * BREAK 用：弹出 loopCtx 及其上方的所有层（含 loopCtx 本身）。
     * 找不到 loopCtx → AbortError（理论上不应发生，Validator 已静态校验）。
     */
    pop_until_including(loopCtx: LoopContextScope): void {
        const idx = this.stack.indexOf(loopCtx);
        if (idx === -1) {
            throw new AbortError(`Loop context not found in stack: ${loopCtx.loopNodeId}`);
        }
        if (idx === 0) {
            throw new AbortError('Cannot pop the last remaining scope layer');
        }
        this.stack.splice(idx);  // 移除 idx 及以上所有层
    }

    /**
     * CONTINUE 用：弹出最内层 loop-context 上方的所有层（iteration scope），保留 loop-context。
     * 无 loop-context → AbortError（CONTINUE 越界）。
     */
    pop_above_loop_context(): void {
        let loopIdx = -1;
        for (let i = this.stack.length - 1; i >= 0; i--) {
            if (this.stack[i].kind === 'loop-context') {
                loopIdx = i;
                break;
            }
        }
        if (loopIdx === -1) {
            throw new AbortError('CONTINUE outside loop: no loop-context found');
        }
        // 保留 loopIdx 层（含）以下所有层，移除以上层
        this.stack.splice(loopIdx + 1);
    }

    // ── visible_vars ──────────────────────────────────────────────────────────

    /**
     * 返回当前可见变量快照（内层覆盖外层同名变量）。
     * 传给 EvalEngine 的 vars 字段。
     */
    visible_vars(): Record<string, Value> {
        let result: Record<string, Value> = {};
        // 从外向内合并，后面（内层）覆盖前面（外层）
        for (const scope of this.stack) {
            result = {...result, ...scope.vars};
        }
        return result;
    }

    /** Validate retained state after a node, including in-place mutations by host code. */
    assertSerializable(): void {
        this.stack.forEach(scope => this.validateScope(scope));
    }

    /** Validate/adopt ordinary VM objects in place; never split shared references. */
    normalizeValues(): void {
        this.assertSerializable();
        for (const scope of this.stack) {
            adoptWorkflowValue(scope.vars);
            if (scope.kind === 'loop-context' && scope.array !== undefined) adoptWorkflowValue(scope.array);
        }
    }

    serialize(copy = createStateCopier()): ScopeStackSnapshot {
        this.assertSerializable();
        return copy(this.stack);
    }

    // ── serialize / deserialize（checkpoint 持久化）───────────────────────────

    deserialize(snapshot: ScopeStackSnapshot, copy = createStateCopier()): void {
        snapshot.forEach(scope => this.validateScope(scope));
        this.stack = copy(snapshot);
    }

    private validateScope(scope: Scope): void {
        if (!scope.vars || typeof scope.vars !== 'object' || Array.isArray(scope.vars))
            throw new AbortError('Scope variables must be a JSON object');
        assertWorkflowValue(scope.vars);
        if (scope.kind === 'loop-context' && scope.array !== undefined) {
            if (!Array.isArray(scope.array)) throw new AbortError('Loop values must be a JSON array');
            assertWorkflowValue(scope.array);
        }
    }
}

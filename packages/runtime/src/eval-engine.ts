import {adoptWorkflowValue, assertReturnValue, assertWorkflowValue} from './workflow-value';
/**
 * EvalEngine — vm.runInNewContext 表达式求值（规范 docs/ts-subset-spec.md，架构 §2.8）
 *
 * 生命周期：start()/stop() 设置/重置运行标志，无外部进程。
 * 无状态：所有变量通过 vars 每次注入，每次 eval 创建独立 sandbox。
 * 普通数据模式不按外形转换对象；默认旧模式保留根变量 FileRef 路径投影。
 */
import vm from 'vm';
import {AbortError, isFileRef, type Value} from './types';

const SANDBOX_GLOBALS = Object.freeze({
    __openhilo_return_value__: assertReturnValue,
    __openhilo_data_value__<T>(value: T): T {
        if (typeof value === 'function') throw new AbortError('Unsupported function value escape; invoke supported methods directly');
        return value;
    },
    __openhilo_property_key__(value: unknown): PropertyKey {
        // Let JS perform ToPropertyKey once; preserving symbols/coercion order.
        const key = Reflect.ownKeys({[value as PropertyKey]: null})[0];
        if (key === 'constructor' || key === 'prototype' || key === '__proto__')
            throw new AbortError(`Unsupported prototype/constructor reflection key: ${String(key)}`);
        return key;
    },
    Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, isFinite,
});

export interface EvaluationOptions {
    fileReferences?: 'data' | 'legacy-path'
}

export class EvalEngine {
    private stopped = false;

    /** 标记引擎为运行状态（幂等） */
    start(): void {
        this.stopped = false;
    }

    /** 标记引擎为停止状态（幂等） */
    async stop(): Promise<void> {
        this.stopped = true;
    }

    /**
     * 求值 TypeScript/JS 表达式。
     * @param expr JS 表达式字符串（见 docs/ts-subset-spec.md §4）
     * @param vars 当前可见变量（来自 ScopeManager.visible_vars()）
     * @param options 新编译产物使用 data；默认 legacy-path 保持旧原始求值 API 行为
     * @returns 求值结果
     * @throws AbortError 当表达式出错、引用未声明变量、或引擎已停止
     */
    async eval(expr: string, vars: Record<string, Value>, options?: EvaluationOptions): Promise<Value> {
        if (this.stopped) {
            throw new AbortError('EvalEngine is not running');
        }
        assertWorkflowValue(vars);
        const context = vm.createContext({...SANDBOX_GLOBALS, ...(options?.fileReferences === 'data' ? vars : this.flattenVars(vars))});
        try {
            const result = vm.runInNewContext(`"use strict"; (${expr})`, context, {timeout: 1000}) as Value;
            // Check synchronously before an async return could assimilate a Promise/thenable.
            // Undefined remains useful as an intermediate JS result (e.g. optional chaining),
            // but scope writes and persistence reject it.
            // Adopt ordinary VM prototypes without changing reference identity, so
            // downstream host contracts can consume object and array literals.
            const normalized = result === undefined ? result : adoptWorkflowValue(result);
            assertWorkflowValue(vars);
            return normalized;
        } catch (e) {
            throw new AbortError(`Expression evaluation error: ${(e as Error).message}`);
        } finally {
            // Returned plain objects must not keep prior workflow roots via VM globals.
            for (const key of Object.keys(context)) delete context[key];
        }
    }

    /** FileRef → 路径字符串；其他值原样传入 */
    private flattenVars(vars: Record<string, Value>): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(vars).map(([k, v]) => [k, isFileRef(v) ? v.path : v]),
        );
    }
}

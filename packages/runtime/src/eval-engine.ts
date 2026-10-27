import {adoptWorkflowValue, assertWorkflowValue} from './workflow-value';
/**
 * EvalEngine — 隔离 realm 表达式求值（语言子集见 packages/compiler/LANGUAGE.md）
 *
 * 生命周期：start()/stop() 设置/重置运行标志，无外部进程。
 * 无状态：每次 eval 创建独立 realm，只使用该 realm 自身的内建对象；宿主函数/对象不进入 sandbox。
 * 普通数据模式不按外形转换对象；默认旧模式保留根变量 FileRef 路径投影。
 */
import vm from 'vm';
import {types} from 'node:util';
import {AbortError, isFileRef, type Value} from './types';

const CONTEXT_OPTIONS = {codeGeneration: {strings: false, wasm: false}, microtaskMode: 'afterEvaluate'} as const;
const TIMEOUT_MS = 1000;
const DEFERRED_KEYWORDS = new Set(['import', 'async']);

// Runs inside each fresh realm before user code. Asynchronous and deferred callbacks would
// outlive the evaluation timeout or surface host-realm rejections, so their sources are removed.
const REALM_SETUP = new vm.Script(`"use strict"; (() => {
    const ownKeys = Reflect.ownKeys, keysOf = Object.keys, hasOwn = Object.hasOwn, isArray = Array.isArray;
    const fail = message => { throw new Error(message); };
    for (const name of ownKeys(globalThis))
        if (typeof name === 'string' && /Promise|Async|WebAssembly|FinalizationRegistry|WeakRef/.test(name)) delete globalThis[name];
    delete Array.fromAsync;
    delete Atomics.waitAsync;
    globalThis.__openhilo_return_value__ = (value, keys) => {
        if (value === null || typeof value !== 'object' || isArray(value)) fail('Workflow return must be an object with the declared output fields');
        if (keysOf(value).length !== keys.length || keys.some(key => !hasOwn(value, key))) fail('Workflow return fields must exactly match the declared output fields');
        return value;
    };
    globalThis.__openhilo_data_value__ = value => typeof value === 'function' ? fail('Unsupported function value escape; invoke supported methods directly') : value;
    globalThis.__openhilo_property_key__ = value => {
        // Let JS perform ToPropertyKey once; preserving symbols/coercion order.
        const key = ownKeys({[value]: null})[0];
        if (key === 'constructor' || key === 'prototype' || key === '__proto__')
            fail('Unsupported prototype/constructor reflection key: ' + String(key));
        return key;
    };
    return [Object.prototype, Array.prototype];
})()`);

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
     * @param expr 编译器发射的 JS 表达式字符串
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
        if (typeof expr !== 'string') throw new AbortError('Expression evaluation error: expression must be a string');
        const keyword = deferredKeyword(expr);
        if (keyword) throw new AbortError(`Expression evaluation error: "${keyword}" is not supported in expressions`);
        const bindings = options?.fileReferences === 'data' ? vars : this.flattenVars(vars);
        // A null-prototype sandbox keeps global lookups from falling through to host Object.prototype.
        const sandbox: Record<string, unknown> = Object.create(null);
        const context = vm.createContext(sandbox, CONTEXT_OPTIONS);
        const [objectPrototype, arrayPrototype] = REALM_SETUP.runInContext(context) as [object, object];
        const toRealm = new Map<object, object>([[Object.prototype, objectPrototype], [Array.prototype, arrayPrototype]]);
        const toHost = new Map<object, object>([[objectPrototype, Object.prototype], [arrayPrototype, Array.prototype]]);
        let result: unknown;
        try {
            // Workflow data keeps its identity (in-place mutation is supported) but uses realm prototypes,
            // so no reachable constructor belongs to the host.
            rehome(bindings, toRealm);
            for (const [key, value] of Object.entries(bindings)) {
                Object.defineProperty(sandbox, key, {value, enumerable: true, writable: true, configurable: true});
            }
            const script = new vm.Script(`"use strict"; (${expr})`);
            result = script.runInContext(context, {timeout: TIMEOUT_MS});
        } catch (e) {
            throw new AbortError(`Expression evaluation error: ${errorMessage(e)}`);
        } finally {
            rehome(bindings, toHost);
            rehome(result, toHost);
            // Returned plain objects must not keep prior workflow roots via VM globals.
            for (const key of Object.keys(sandbox)) delete sandbox[key];
        }
        try {
            // Check synchronously before an async return could assimilate a Promise/thenable.
            // Undefined remains useful as an intermediate JS result (e.g. optional chaining),
            // but scope writes and persistence reject it.
            const normalized = result === undefined ? result : adoptWorkflowValue(result);
            assertWorkflowValue(vars);
            return normalized as Value;
        } catch (e) {
            throw new AbortError(`Expression evaluation error: ${errorMessage(e)}`);
        }
    }

    /** FileRef → 路径字符串；其他值原样传入 */
    private flattenVars(vars: Record<string, Value>): Record<string, Value> {
        return Object.fromEntries(
            Object.entries(vars).map(([k, v]) => [k, isFileRef(v) ? v.path : v]),
        );
    }
}

/** Swap exact plain prototypes between realms without invoking accessors or proxy traps. */
function rehome(value: unknown, prototypes: Map<object, object>, seen = new Set<object>()): void {
    if (value === null || typeof value !== 'object' || seen.has(value) || types.isProxy(value)) return;
    seen.add(value);
    const target = prototypes.get(Object.getPrototypeOf(value));
    if (target) {
        try {
            Object.setPrototypeOf(value, target);
        } catch { /* Nonextensible values are rejected by validation. */
        }
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in descriptor) rehome(descriptor.value, prototypes, seen);
    }
}

/** Read realm exceptions without running user getters or coercions outside the timeout. */
function errorMessage(error: unknown): string {
    if (error === null || typeof error !== 'object') return typeof error === 'symbol' ? error.toString() : String(error);
    if (types.isProxy(error)) return 'non-error exception';
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    return message && 'value' in message && typeof message.value === 'string' ? message.value : 'non-error exception';
}

const REGEX_AFTER_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/**
 * First `import`/`async` keyword in code position, if any. Strings, templates, comments and regex literals
 * are skipped. `/` is classified by the preceding token; a misclassification may only scan extra text as code,
 * and genuinely ambiguous input (`x++ /`, HTML-like comments, unterminated literals) falls back to a
 * conservative whole-source match.
 */
function deferredKeyword(source: string): string | undefined {
    const conservative = () => /(?<![A-Za-z0-9_$])(import|async)(?![A-Za-z0-9_$])/.exec(source)?.[1];
    const templates: number[] = [];
    // true: a `/` starts a regex; false: division; null: ambiguous.
    let regexAllowed: boolean | null = true, afterDot = false;
    let i = 0;
    const word = (ch: string) => /[A-Za-z0-9_$\\]/.test(ch) || ch.charCodeAt(0) > 127;
    while (i < source.length) {
        const c = source[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') {
            i++;
            continue;
        }
        if (c === '"' || c === "'") {
            i++;
            while (i < source.length && source[i] !== c) {
                if (source[i] === '\n' || source[i] === '\r') return conservative();
                i += source[i] === '\\' ? 2 : 1;
            }
            if (i >= source.length) return conservative();
            i++;
            regexAllowed = false;
        } else if (c === '`' || (c === '}' && templates.at(-1) === 0)) {
            if (c === '}') templates.pop();
            i++;
            while (i < source.length && source[i] !== '`' && !(source[i] === '$' && source[i + 1] === '{')) i += source[i] === '\\' ? 2 : 1;
            if (i >= source.length) return conservative();
            if (source[i] === '$') {
                templates.push(0);
                i += 2;
                regexAllowed = true;
            } else {
                i++;
                regexAllowed = false;
            }
        } else if (c === '/' && source[i + 1] === '/') {
            while (i < source.length && !'\n\r\u2028\u2029'.includes(source[i])) i++;
        } else if (c === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            if (end === -1) return conservative();
            i = end + 2;
        } else if (source.startsWith('<!--', i) || source.startsWith('-->', i)) {
            return conservative();
        } else if (c === '/') {
            if (regexAllowed === null) return conservative();
            if (regexAllowed) {
                let inClass = false;
                i++;
                while (i < source.length && (inClass || source[i] !== '/')) {
                    if (source[i] === '\n' || source[i] === '\r') return conservative();
                    if (source[i] === '\\') i++;
                    else if (source[i] === '[') inClass = true;
                    else if (source[i] === ']') inClass = false;
                    i++;
                }
                if (i >= source.length) return conservative();
                i++;
                while (i < source.length && word(source[i])) i++;
                regexAllowed = false;
            } else {
                i++;
                regexAllowed = true;
            }
            afterDot = false;
            continue;
        } else if (word(c)) {
            const start = i;
            while (i < source.length && word(source[i])) i++;
            const token = source.slice(start, i);
            if (!afterDot && DEFERRED_KEYWORDS.has(token)) return token;
            regexAllowed = !afterDot && REGEX_AFTER_KEYWORDS.has(token);
        } else {
            if (templates.length && c === '{') templates[templates.length - 1]++;
            else if (templates.length && c === '}') templates[templates.length - 1]--;
            if (source.startsWith('...', i)) {
                i += 3;
                regexAllowed = true;
                afterDot = false;
                continue;
            }
            if ((c === '+' || c === '-') && source[i + 1] === c) {
                i += 2;
                regexAllowed = null;
                afterDot = false;
                continue;
            }
            regexAllowed = !(c === ')' || c === ']' || c === '}');
            i++;
            afterDot = c === '.';
            continue;
        }
        afterDot = false;
    }
    return templates.length ? conservative() : undefined;
}

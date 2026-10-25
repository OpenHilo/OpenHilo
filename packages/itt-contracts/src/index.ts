import type { InputShape } from './run-inputs';
import type {AiSelection} from './ai-selection';
export interface ExtensionRequirement {
    namespace: string;
    version: number
}

/**
 * OpenHilo v2 CFG 类型定义
 *
 * ITT v2 格式基于扁平化有向控制流图（CFG），以 while True 状态机驱动执行。
 * 依赖规范：docs/itt-format-spec-v2.md
 * 依赖架构：docs/plans/2026-03-16-scheduler-architecture.md
 */

// ============================================================================
// 值类型
// ============================================================================

/** ITT v2 支持的变量类型 */
export type ValueType = 'text' | 'number' | 'boolean' | 'json' | 'file' | 'dir';

/** 运行时值 — 标量或工作区文件引用 */
export type Value = string | number | boolean | object | null | FileRef;

/**
 * 文件引用（引用语义）：大文件/目录不内联，记录路径+哈希+mtime。
 * file/dir 类型变量始终以文件引用形式序列化到 JSONL 事件和 checkpoint。
 */
export interface FileRef {
    type: 'file_ref';
    path: string;   // 相对于 ITT_WORKSPACE 的相对路径（ITT_WORKSPACE 本身存绝对路径）
    hash: string;   // e.g. "sha256:abcd1234..."
    mtime: number;  // Unix 时间戳（秒）
}

export function isFileRef(v: unknown): v is FileRef {
    if (v === null || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    return (
        o.type === 'file_ref' &&
        typeof o.path === 'string' &&
        typeof o.hash === 'string' &&
        typeof o.mtime === 'number'
    );
}

// ============================================================================
// CFG 节点类型（规范 §5–§9）
// ============================================================================

/** assign 节点：计算表达式并写入变量 */
export interface AssignNode {
    id: string;
    type: 'assign';
    assignments: Array<{
        var: string;
        type: ValueType;
        expr: string;  // JS 表达式（见 docs/ts-subset-spec.md §4）
    }>;
    next: string;   // 下一个节点 ID 或 'END'
}

/** if 节点：条件分支 */
export interface IfNode {
    id: string;
    type: 'if';
    condition: string;  // JS 布尔表达式（见 docs/ts-subset-spec.md §4）
    next_true: string;
    next_false: string;
}

/** for 节点：C 风格计数循环 */
export interface ForNode {
    id: string;
    type: 'for';
    init: Array<{ var: string; type?: ValueType; expr: string }>;
    condition: string;
    step: Array<{ var: string; type?: ValueType; expr: string }>;
    next_body: string;
    next_exit: string;
}

/** foreach 节点：数组迭代 */
export interface ForeachNode {
    id: string;
    type: 'foreach';
    array_expr: string;
    item_var: string;
    index_var?: string;
    next_body: string;
    next_exit: string;
}

/** call 节点：调用 AI/代码/人工执行器 */
export interface CallNode {
    id: string;
    type: 'call';
    executor: 'ai' | 'code' | 'human' | 'sys' | 'intent';
    callee?: string;       // ai/human: 被调用的 intent 名称
    intent?: string;       // ai/human: 任务描述（支持 ${var} 插值）
    role?: string;         // ai/human: 执行角色描述
    constraints?: string[];// ai/human: 约束条件数组
    aiSelection?: AiSelection;
    model?: string;        // ai: 语义化 model key
    skills?: string[];     // ai: CC skill names (namespaced), e.g. ['superpowers:tdd']
    script?: string;       // code: 脚本内容
    lang?: string;         // code: "bash"（默认）或 "py"
    inputs?: Record<string, { kind: ValueType; shape?: InputShape }>;   // 函数签名：形参声明
    outputs?: Record<string, ValueType>;             // 函数签名：返回值声明
    inputsFrom: Record<string, string>;  // 实参绑定：paramName → localVar
    outputsTo: Record<string, string>;   // 输出捕获：outputField → varName
    /** Optional whole-result capture for internal workflow calls; preserves identity. */
    resultTo?: string;
    on_failure?: string;  // 失败时跳转节点 ID，或 'ABORT'（默认）
    next: string;
}

/** CFG 节点联合类型 */
export type CFGNode = AssignNode | IfNode | ForNode | ForeachNode | CallNode;

// ── 类型守卫 ─────────────────────────────────────────────────────────────────

export function isAssignNode(n: unknown): n is AssignNode {
    return isCFGNodeBase(n) && (n as CFGNode).type === 'assign';
}

export function isIfNode(n: unknown): n is IfNode {
    return isCFGNodeBase(n) && (n as CFGNode).type === 'if';
}

export function isForNode(n: unknown): n is ForNode {
    return isCFGNodeBase(n) && (n as CFGNode).type === 'for';
}

export function isForeachNode(n: unknown): n is ForeachNode {
    return isCFGNodeBase(n) && (n as CFGNode).type === 'foreach';
}

export function isCallNode(n: unknown): n is CallNode {
    return isCFGNodeBase(n) && (n as CFGNode).type === 'call';
}

export function isCFGNode(n: unknown): n is CFGNode {
    return isCFGNodeBase(n);
}

function isCFGNodeBase(n: unknown): n is CFGNode {
    if (n === null || n === undefined || typeof n !== 'object') return false;
    const o = n as { type?: unknown };
    return ['assign', 'if', 'for', 'foreach', 'call'].includes(o.type as string);
}

// ============================================================================
// ITT v2 格式（规范 §3）
// ============================================================================

/** ITT v2 顶层结构（CFG 格式） */
export interface CFGITT {
    version: 2;
    name?: string;          // ITT 名称（与文件名一致）
    description?: string;   // 人类可读说明
    namespace?: string;     // 本文件的 namespace（如 "docs.utils"），未声明则为 ""
    imports?: Record<string, string>;  // 短名 → 全限定名（如 { "helper": "utils.helper" }）
    entry: string;
    nodes: Record<string, CFGNode>;
    inputs?: Record<string, { kind: ValueType; shape?: InputShape; ask?: string }>;
    outputs?: Record<string, string>;  // outputKey → varName
    /** Optional scope root holding the checked whole return object. */
    resultVar?: string;
    /** Plain data in expressions; file paths are projected only by declared boundaries. */
    expressionSemantics?: 'plain-data';
    /** Legacy metadata interpreted by an explicitly installed application policy. */
    level?: string;
    requiredExtensions?: ExtensionRequirement[];
    public?: boolean;   // undefined or true = public; false = private
}

/**
 * Leaf ITT（`name.itt.json`，规范 §4.1）
 *
 * 定义单个执行单元的接口。与 CFGITT 不同，Leaf ITT 不包含 CFG（无 entry/nodes），
 * 而是包含执行配置（executor、role、model、constraints、intent）和函数签名（inputs、outputs）。
 *
 * 执行器类型：
 * - "ai"：AI 函数节点（TS 中以 _by_ai 结尾）
 * - "human"：人工节点（TS 中以 _by_human 结尾）
 * - "intent"：意图节点（TS 中不带特殊后缀的普通函数调用，会被分解为 impl ITT）
 *
 * `nodes: {}` 保留以兼容 Snapshotter（extractCallees 需要遍历 nodes）。
 */
export interface LeafITT {
    version: 2;
    name?: string;
    namespace?: string;        // dot-notation namespace (e.g. "docs.utils"), "" for root
    executor: 'ai' | 'human' | 'intent';
    role?: string;            // ai/human: 角色描述
    aiSelection?: AiSelection;
    model?: string;           // ai: 语义化 model key
    skills?: string[];         // ai: CC skill names (namespaced), e.g. ['superpowers:tdd']
    constraints?: string[];   // ai/human: 约束条件
    intent?: string;          // ai/human: 任务描述（支持 ${var} 插值）
    inputs?: Record<string, { kind: ValueType; shape?: InputShape }>;   // 函数形参声明
    outputs?: Record<string, ValueType>;             // 函数返回值声明，outputKey → type
    nodes: Record<string, never>;  // 始终为 {}，供 Snapshotter 遍历
    entry: string;                 // 占位符，Leaf ITT 无实际 CFG entry
    /** Legacy metadata interpreted by an explicitly installed application policy. */
    level?: string;
    requiredExtensions?: ExtensionRequirement[];
    tags?: Record<string, string>;         // application-defined workflow tags
    public?: boolean;   // undefined or true = public; false = private (not indexed, not shown in UI)
}

// ============================================================================
// 保留字（规范 §8）
// ============================================================================

/** CFG 控制流保留字，不能用作节点 ID 或变量名 */
export const RESERVED_WORDS_V2: ReadonlySet<string> = new Set([
    'END',
    'BREAK',
    'CONTINUE',
    'ABORT',
]);


export {Validator as IttValidator, type ValidationResult as IttValidationResult} from './validator';

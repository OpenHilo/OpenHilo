import type {Value, ValueType} from '@openhilo/itt-contracts';
import {AbortError} from '@openhilo/runtime-contracts';

export interface CodeExecutionOptions {
    /** Optional subprocess deadline, in milliseconds. Includes waiting for inherited pipes. */
    timeoutMs?: number;
    /** Combined stdout/stderr byte budget; defaults to 10 MiB. Infinity disables it. */
    maxOutputBytes?: number;
    /** Serialized business-result byte budget; defaults to 10 MiB. Infinity disables it. */
    maxResultBytes?: number;
    /** SIGTERM grace period before SIGKILL, default 1000 ms. */
    killGraceMs?: number;
    /** Host cancellation; awaiting the returned promise also awaits process cleanup. */
    signal?: AbortSignal;
    /**
     * Extra environment variables for the subprocess. Only an allowlist of host
     * variables (PATH, HOME, locale, ...) is inherited; credentials must be opted in here.
     */
    env?: Record<string, string>;
}

export type CodeProcessFailureReason = 'timeout' | 'cancelled' | 'output_limit' | 'result_limit';

/** Control failures abort the workflow; partial outputs are diagnostic only. */
export class CodeProcessError extends AbortError {
    stdout = '';
    stderr = '';
    constructor(public readonly reason: CodeProcessFailureReason, message: string) {
        super(message);
        this.name = 'CodeProcessError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** Code executor 配置 */
export interface CodeExecutorConfig extends CodeExecutionOptions {
    command: string;
    envVars: Record<string, string>;
    workingDir: string;
    shell?: 'bash' | 'sh';                         // explicit interpreter; omitted retains legacy selection
    declaredOutputs?: Record<string, ValueType>;  // typed outputs to capture via EXIT trap
    workspaceDir?: string;                         // ITT_WORKSPACE for file/dir path resolution
}

/** Python executor 配置 */
export interface PythonExecutorConfig extends CodeExecutionOptions {
    script: string;
    inputs: Record<string, unknown>;   // bare variable names, FileRef already unwrapped to abs path
    declaredOutputs: Record<string, ValueType>;
    workspaceDir: string;
    workingDir: string;
}

/** Typed variable output from a code executor (one per declared output in `node.outputs`). */
export interface CodeOutput {
    name: string;      // output key (without ITT_ prefix)
    type: ValueType;   // declared ITT type
    value: Value;      // validated, converted value ready for scope
}

/** Local process result; deliberately distinct from the AI task contract. */
export interface CodeExecutionResult {
    text: string;
    stderr: string;
    files: string[];
    exitCode: number;
    typedOutputs?: CodeOutput[];
    meta: { executor: string; startedAt: string; finishedAt: string };
}

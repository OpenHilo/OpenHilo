import type {Value, ValueType} from '@openhilo/itt-contracts';

/** Code executor 配置 */
export interface CodeExecutorConfig {
    command: string;
    envVars: Record<string, string>;
    workingDir: string;
    declaredOutputs?: Record<string, ValueType>;  // typed outputs to capture via EXIT trap
    workspaceDir?: string;                         // ITT_WORKSPACE for file/dir path resolution
}

/** Python executor 配置 */
export interface PythonExecutorConfig {
    script: string;
    inputs: Record<string, unknown>;   // ITT_-prefixed keys, FileRef already unwrapped to abs path
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

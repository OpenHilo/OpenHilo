import * as path from 'path';
import {FailableError} from '@openhilo/runtime-contracts';
import {CodeProcessError} from './types';
import {isFileRef, type Value} from '@openhilo/itt-contracts';
import type {ExecutorFn} from '@openhilo/runtime/execution-engine';
import {executeCode, executePython} from './process';
import type {CodeExecutionOptions} from './types';
import {normalizeOptions} from './process-control';

function toBashEnvVar(v: Value, workspaceDir: string): string {
    if (isFileRef(v)) return path.join(workspaceDir, v.path);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return String(v ?? '');
}

/**
 * Convert an ITT Value to a Python-native value for the input JSON.
 * FileRef → absolute path string; all other types pass through
 * (JSON round-trip preserves number/boolean/string/array/object natively).
 * See this package's README for the local Code input/output contract.
 */
function toPythonInputValue(v: Value, workspaceDir: string): unknown {
    if (isFileRef(v)) return path.join(workspaceDir, v.path);
    return v;
}

const LANGUAGES = new Set(['bash', 'py', 'python']);

/** Preserve the Bash/Python node ABI behind Runtime's executor port. */
type Implementations = {executeCode: typeof executeCode; executePython: typeof executePython};
export function createCodeExecutor(workdir: string, options?: CodeExecutionOptions, implementations?: Implementations): ExecutorFn;
export function createCodeExecutor(workdir: string, implementations: Implementations): ExecutorFn;
export function createCodeExecutor(workdir: string, optionsOrImplementations: CodeExecutionOptions | Implementations = {},
                                   suppliedImplementations: Implementations = {executeCode, executePython}): ExecutorFn {
    const legacy = 'executeCode' in optionsOrImplementations;
    const implementations = legacy ? optionsOrImplementations : suppliedImplementations;
    const options = normalizeOptions(legacy ? {} : optionsOrImplementations);
    return async (node, inputs) => {
        if (node.type !== 'call' || node.executor !== 'code') throw new Error('Local code executor requires a code call node');
        const lang = node.lang ?? 'bash';
        if (!LANGUAGES.has(lang)) throw new Error(`Local code executor does not support lang '${lang}'; use 'bash', 'py' or 'python'`);
        try {
        // Stream captures are not business variables in the script.
        const RESERVED = new Set(['stdout', 'stderr', 'exit_code']);
        const declaredOutputs = Object.fromEntries(
            Object.entries(node.outputs ?? {}).filter(([k]) => !RESERVED.has(k)),
        );
        const workspaceDir = workdir;

        if (lang === 'py' || lang === 'python') {
            // Python path: pass native-typed inputs as JSON globals.
            const pythonInputs = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, toPythonInputValue(value, workspaceDir)]));

            const result = await implementations.executePython({
                ...options,
                script: node.script ?? '',
                inputs: pythonInputs,
                declaredOutputs,
                workspaceDir,
                workingDir: workspaceDir,
            });

            const outputs: Record<string, Value> = {
                stdout: result.text,
                stderr: result.stderr,
                exit_code: result.exitCode,
                ...Object.fromEntries((result.typedOutputs ?? []).map(output => [output.name, output.value])),
            };
            return {outputs};
        }

        // Bash workflow nodes keep their interpreter regardless of output declarations.
        const envVars = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, toBashEnvVar(value, workspaceDir)]));

        const result = await implementations.executeCode({
            ...options,
            command: node.script ?? '',
            shell: 'bash',
            envVars,
            workingDir: workspaceDir,
            declaredOutputs,
            workspaceDir,
        });

        const outputs: Record<string, Value> = {
            stdout: result.text,
            stderr: result.stderr,
            exit_code: result.exitCode,
            ...Object.fromEntries((result.typedOutputs ?? []).map(output => [output.name, output.value])),
        };
        return {outputs};
        } catch (error) {
            if (options.signal?.aborted || (error instanceof CodeProcessError && error.reason === 'cancelled')) throw error;
            if (error instanceof Error) throw new FailableError(error.message, {code: 'executor_failed', message: error.message, retryable: false, safeToReplay: false}, (error as Error & {diagnostics?: import('@openhilo/runtime-contracts').ExecutionDiagnostics}).diagnostics);
            throw error;
        }
    };
}

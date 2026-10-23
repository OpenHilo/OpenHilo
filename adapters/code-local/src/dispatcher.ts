import * as path from 'path';
import {isFileRef, type Value} from '@openhilo/itt-contracts';
import type {ExecutorFn} from '@openhilo/runtime/execution-engine';
import {executeCode, executePython} from './process';

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

/** Preserve the Bash/Python node ABI behind Runtime's executor port. */
export function createCodeExecutor(workdir: string, implementations = {executeCode, executePython}): ExecutorFn {
    return async (node, inputs) => {
        if (node.type !== 'call' || node.executor !== 'code') throw new Error('Local code executor requires a code call node');
        const lang = node.lang ?? 'bash';
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
    };
}

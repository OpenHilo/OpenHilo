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
 * §3 of the ABI spec.
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
        // stdout/stderr/exit_code are reserved stream captures — never pass to ITT_ var mechanism
        const RESERVED = new Set(['stdout', 'stderr', 'exit_code']);
        const declaredOutputs = Object.fromEntries(
            Object.entries(node.outputs ?? {}).filter(([k]) => !RESERVED.has(k)),
        );
        const workspaceDir = workdir;

        if (lang === 'py' || lang === 'python') {
            // Python path: pass native-typed inputs as JSON globals (§3)
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

        // Bash path: inject as env vars (§4)
        const envVars = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, toBashEnvVar(value, workspaceDir)]));

        const result = await implementations.executeCode({
            command: node.script ?? '',
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

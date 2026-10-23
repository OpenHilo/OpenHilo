/**
 * Code Executor Module
 *
 * Executes shell commands as subprocesses with environment variable injection.
 * Input/output contract: adapters/code-local/README.md.
 */

import {spawn} from 'child_process';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {AbortError, ExecutionError} from '@openhilo/runtime-contracts';
import type {ValueType} from '@openhilo/itt-contracts';
import type {CodeExecutionResult as TaskResult, CodeExecutorConfig, CodeOutput, PythonExecutorConfig} from './types';
import {makeFileRef} from '@openhilo/runtime/file-reference';

// ── Bash prologue generation ──────────────────────────────────────────────────

/**
 * Generate a #!/bin/bash EXIT-trap prologue for capturing declared output vars.
 * Each declared output gets a capture block using `${VAR+set}` to distinguish
 * unset from set-but-empty. Values are written NUL-delimited:
 *   name\000+\000value\000   (set)
 *   name\000-\000            (unset)
 *
 * Returns empty string if no declared outputs (no prologue needed).
 */
export function generateBashPrologue(outputKeys: string[]): string {
    if (outputKeys.length === 0) return '';
    const blocks = outputKeys
        .map(
            key =>
                `  if [ "\${${key}+set}" = set ]; then\n` +
                `    printf '${key}\\000+\\000%s\\000' "\${${key}}" >> "$_ITT_OUT"\n` +
                `  else\n` +
                `    printf '${key}\\000-\\000' >> "$_ITT_OUT"\n` +
                `  fi`,
        )
        .join('\n');
    return `#!/bin/bash\n_itt_capture() {\n${blocks}\n}\ntrap '_itt_capture' EXIT\n`;
}

// ── Bash output file parsing ──────────────────────────────────────────────────

/** Raw capture result per declared output: string value if set, null if unset. */
type RawOutputs = Record<string, string | null>;

/**
 * Parse the NUL-delimited output file written by the EXIT trap.
 * Format (repeated): name\000+\000value\000  or  name\000-\000
 */
export function parseBashOutputFile(data: Buffer): RawOutputs {
    const result: RawOutputs = {};
    const fields: string[] = [];
    let start = 0;
    for (let i = 0; i <= data.length; i++) {
        if (i === data.length || data[i] === 0) {
            fields.push(data.slice(start, i).toString('utf8'));
            start = i + 1;
        }
    }
    let i = 0;
    while (i < fields.length) {
        const name = fields[i];
        if (!name) {
            i++;
            continue;
        }
        const flag = fields[i + 1];
        if (flag === '+') {
            Object.defineProperty(result, name, {
                value: fields[i + 2] ?? '',
                enumerable: true,
                writable: true,
                configurable: true
            });
            i += 3;
        } else if (flag === '-') {
            Object.defineProperty(result, name, {value: null, enumerable: true, writable: true, configurable: true});
            i += 2;
        } else {
            i++;
        }
    }
    return result;
}

// ── Type validation helpers ───────────────────────────────────────────────────

export {makeFileRef} from '@openhilo/runtime/file-reference';

/** File and directory declarations validate the actual filesystem kind. */
async function validatePathOutput(name: string, raw: string, kind: 'file' | 'dir', workspaceDir: string): Promise<CodeOutput> {
    if (!raw) throw new AbortError(`code output '${name}' not set`);
    const workspace = path.resolve(workspaceDir);
    const abs = path.resolve(workspace, raw);
    const relative = path.relative(workspace, abs);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new AbortError(`code output '${name}': path must be under ITT_WORKSPACE`);
    }
    let stat;
    try {
        stat = await fsPromises.stat(abs);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        throw new AbortError(`code output '${name}': path '${relative}' not found`);
    }
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
        throw new AbortError(`code output '${name}': path must be ${kind}`);
    }
    return {name, type: kind, value: await makeFileRef(abs, workspace, name)};
}

/**
 * Validate and convert a raw bash string output to a typed ITT Value.
 * Throws AbortError on type mismatch or missing value.
 */
export async function validateBashOutput(
    name: string,
    raw: string | null,
    declaredType: ValueType,
    workspaceDir: string,
): Promise<CodeOutput> {
    if (raw === null) {
        throw new AbortError(`code output '${name}' not set`);
    }
    switch (declaredType) {
        case 'text':
            return {name, type: 'text', value: raw};

        case 'number': {
            const n = Number(raw);
            if (isNaN(n) || !isFinite(n)) {
                throw new AbortError(`code output '${name}': "${raw}" is not a valid number`);
            }
            return {name, type: 'number', value: n};
        }

        case 'boolean': {
            if (raw === 'true') return {name, type: 'boolean', value: true};
            if (raw === 'false') return {name, type: 'boolean', value: false};
            throw new AbortError(`code output '${name}': expected "true"/"false", got "${raw}"`);
        }

        case 'json': {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new AbortError(`code output '${name}': JSON parse failed`);
            }
            if (!Array.isArray(parsed) && (typeof parsed !== 'object' || parsed === null)) {
                throw new AbortError(
                    `code output '${name}': expected object or array, got ${parsed === null ? 'null' : typeof parsed}`,
                );
            }
            return {name, type: 'json', value: parsed as object};
        }

        case 'file':
        case 'dir': {
            return validatePathOutput(name, raw, declaredType, workspaceDir);
        }
    }
}

// ── Main executeCode function ─────────────────────────────────────────────────

/**
 * Execute a bash/shell command.
 *
 * When `config.declaredOutputs` is non-empty, prepends a bash EXIT-trap
 * prologue, runs with `bash` (not `sh`), and captures typed output variables.
 * Without `declaredOutputs`, defaults to `sh` (backward-compatible).
 * An explicit `config.shell` overrides this default; workflow Bash nodes use it.
 *
 * @param config.command          - shell command (from node.script)
 * @param config.envVars          - bare-name environment variables (keyed by exact parameter name)
 * @param config.workingDir       - working directory
 * @param config.declaredOutputs  - typed outputs to capture (optional)
 * @param config.workspaceDir     - ITT_WORKSPACE for file/dir path resolution
 * @returns TaskResult (with .typedOutputs if declaredOutputs provided)
 * @throws ExecutionError - when process cannot spawn
 * @throws AbortError     - on type mismatch or missing declared output
 */
export async function executeCode(config: CodeExecutorConfig): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    const declaredOutputs = config.declaredOutputs ?? {};
    const outputKeys = Object.keys(declaredOutputs);
    const hasDeclaredOutputs = outputKeys.length > 0;

    const prologue = generateBashPrologue(outputKeys);
    const interpreter = config.shell ?? (hasDeclaredOutputs ? 'bash' : 'sh');
    const fullScript = prologue ? prologue + '\n' + config.command : config.command;

    const outFilePath = hasDeclaredOutputs
        ? path.join(os.tmpdir(), `itt_bash_out_${Date.now()}_${Math.random().toString(36).slice(2)}`)
        : '';

    const env: NodeJS.ProcessEnv = {...process.env, ...config.envVars};
    if (hasDeclaredOutputs) env['_ITT_OUT'] = outFilePath;

    return new Promise((resolve, reject) => {
        const child = spawn(interpreter, ['-c', fullScript], {
            cwd: config.workingDir,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
            const finishedAt = new Date().toISOString();
            const result: TaskResult = {
                text: stdout,
                stderr,
                files: [],
                exitCode: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1),
                meta: {executor: 'code', startedAt, finishedAt},
            };

            if (!hasDeclaredOutputs) {
                resolve(result);
                return;
            }

            try {
                let outData: Buffer;
                try {
                    outData = await fsPromises.readFile(outFilePath);
                } catch {
                    throw new AbortError(`code output '${outputKeys[0]}' not set`);
                }

                const rawOutputs = parseBashOutputFile(outData);
                const typedOutputs: CodeOutput[] = [];

                const workspaceDir = config.workspaceDir ?? config.workingDir;
                for (const [name, declaredType] of Object.entries(declaredOutputs)) {
                    const raw = Object.prototype.hasOwnProperty.call(rawOutputs, name) ? rawOutputs[name] : null;
                    const co = await validateBashOutput(name, raw, declaredType, workspaceDir);
                    typedOutputs.push(co);
                }

                result.typedOutputs = typedOutputs;
                resolve(result);
            } catch (err) {
                if (err instanceof Error && result.exitCode !== 0) {
                    const detail = stderr.trim();
                    err.message += ` (process exited with exit code ${result.exitCode})${detail ? `\n${detail.length > 4000 ? "[last 4000 stderr characters]\n" : ""}${detail.slice(-4000)}` : ''}`;
                }
                reject(err);
            } finally {
                await fsPromises.unlink(outFilePath).catch(() => {
                });
            }
        });

        child.on('error', (err: Error) => {
            reject(
                new ExecutionError(`Failed to spawn process: ${err.message}`, 'unknown', 'code'),
            );
        });
    });
}

// ── Python type validation ────────────────────────────────────────────────────

/**
 * Validate and convert a JSON-decoded Python output value to a typed ITT Value.
 * Throws AbortError on type mismatch or not-JSON-serialisable.
 */
async function validatePythonOutput(
    name: string,
    raw: unknown,
    declaredType: ValueType,
    workspaceDir: string,
    notSerializable: boolean,
): Promise<CodeOutput> {
    if (notSerializable) {
        throw new AbortError(`code output '${name}': value not JSON-serialisable`);
    }
    switch (declaredType) {
        case 'text':
            if (typeof raw !== 'string') {
                throw new AbortError(`code output '${name}': expected text, got ${typeof raw}`);
            }
            return {name, type: 'text', value: raw};

        case 'number':
            if (typeof raw !== 'number') {
                throw new AbortError(`code output '${name}': expected number, got ${typeof raw}`);
            }
            if (isNaN(raw) || !isFinite(raw)) {
                throw new AbortError(`code output '${name}': "${raw}" is not a valid number`);
            }
            return {name, type: 'number', value: raw};

        case 'boolean':
            if (typeof raw !== 'boolean') {
                throw new AbortError(`code output '${name}': expected boolean, got ${typeof raw}`);
            }
            return {name, type: 'boolean', value: raw};

        case 'json': {
            if (!Array.isArray(raw) && (typeof raw !== 'object' || raw === null)) {
                throw new AbortError(
                    `code output '${name}': expected object or array, got ${raw === null ? 'null' : typeof raw}`,
                );
            }
            return {name, type: 'json', value: raw as object};
        }

        case 'file':
        case 'dir': {
            if (typeof raw !== 'string') {
                throw new AbortError(`code output '${name}': expected string path, got ${typeof raw}`);
            }
            return validatePathOutput(name, raw, declaredType, workspaceDir);
        }
    }
}

// ── executePython ─────────────────────────────────────────────────────────────

/**
 * Execute a Python script in an isolated subprocess via _itt_runner.py.
 *
 * The runner:
 *   1. Loads input JSON from $_ITT_INPUT → native Python globals (bare input names)
 *   2. exec()s user script inside the subprocess
 *   3. Reads declared output vars from globals dict
 *   4. Writes output JSON to $_ITT_OUTPUT
 *
 * @throws AbortError on type mismatch, missing output, or non-serialisable value
 */
export async function executePython(config: PythonExecutorConfig): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    const {script, inputs, declaredOutputs, workspaceDir, workingDir} = config;

    const runnerPath = path.resolve(__dirname, '_itt_runner.py');
    const tmpSuffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const inputFilePath = path.join(os.tmpdir(), `itt_py_input_${tmpSuffix}`);
    const scriptFilePath = path.join(os.tmpdir(), `itt_py_script_${tmpSuffix}.py`);
    const outputFilePath = path.join(os.tmpdir(), `itt_py_output_${tmpSuffix}`);

    await fsPromises.writeFile(inputFilePath, JSON.stringify(inputs), 'utf-8');
    await fsPromises.writeFile(scriptFilePath, script, 'utf-8');

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        _ITT_INPUT: inputFilePath,
        _ITT_SCRIPT_FILE: scriptFilePath,
        _ITT_OUTPUT: outputFilePath,
        _ITT_DECLARED_KEYS: JSON.stringify(Object.keys(declaredOutputs)),
    };

    return new Promise((resolve, reject) => {
        const child = spawn('python3', [runnerPath], {
            cwd: workingDir,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on('close', async (code: number | null, signal: NodeJS.Signals | null) => {
            const finishedAt = new Date().toISOString();
            const result: TaskResult = {
                text: stdout,
                stderr,
                files: [],
                exitCode: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1),
                meta: {executor: 'code', startedAt, finishedAt},
            };

            try {
                // Ordinary exceptions and signals can exit before the runner writes
                // JSON. Stream-only callers still need that exit status as data.
                if (Object.keys(declaredOutputs).length === 0) {
                    result.typedOutputs = [];
                    resolve(result);
                    return;
                }
                let outputJson: { outputs: Record<string, unknown>; not_serialisable: string[] };
                try {
                    const outputData = await fsPromises.readFile(outputFilePath, 'utf-8');
                    outputJson = JSON.parse(outputData) as typeof outputJson;
                } catch {
                    const firstKey = Object.keys(declaredOutputs)[0] ?? '?';
                    throw new AbortError(`code output '${firstKey}' not set`);
                }

                const typedOutputs: CodeOutput[] = [];
                for (const [name, declaredType] of Object.entries(declaredOutputs)) {
                    const isNotSerialisable = outputJson.not_serialisable.includes(name);
                    const hasValue = Object.prototype.hasOwnProperty.call(outputJson.outputs, name);

                    if (!hasValue && !isNotSerialisable) {
                        throw new AbortError(`code output '${name}' not set`);
                    }
                    const co = await validatePythonOutput(
                        name,
                        outputJson.outputs[name],
                        declaredType,
                        workspaceDir,
                        isNotSerialisable,
                    );
                    typedOutputs.push(co);
                }
                result.typedOutputs = typedOutputs;
                resolve(result);
            } catch (err) {
                if (err instanceof Error && result.exitCode !== 0) {
                    const detail = stderr.trim();
                    err.message += ` (process exited with exit code ${result.exitCode})${detail ? `\n${detail.length > 4000 ? "[last 4000 stderr characters]\n" : ""}${detail.slice(-4000)}` : ''}`;
                }
                reject(err);
            } finally {
                await Promise.all([
                    fsPromises.unlink(inputFilePath).catch(() => {
                    }),
                    fsPromises.unlink(scriptFilePath).catch(() => {
                    }),
                    fsPromises.unlink(outputFilePath).catch(() => {
                    }),
                ]);
            }
        });

        child.on('error', (err: Error) => {
            reject(new ExecutionError(`Failed to spawn python3: ${err.message}`, 'unknown', 'code'));
        });
    });
}

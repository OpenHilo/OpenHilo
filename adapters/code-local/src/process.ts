/**
 * Code Executor Module
 *
 * Executes shell commands as subprocesses with environment variable injection.
 * Input/output contract: adapters/code-local/README.md.
 */

import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {AbortError} from '@openhilo/runtime-contracts';
import {CodeProcessError} from './types';
import {checkCancelled, normalizeOptions, readResult, runProcess} from './process-control';
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
    const options = normalizeOptions(config);
    checkCancelled(options.signal);
    const declaredOutputs = config.declaredOutputs ?? {};
    const outputKeys = Object.keys(declaredOutputs);
    const prologue = generateBashPrologue(outputKeys);
    const interpreter = config.shell ?? (outputKeys.length ? 'bash' : 'sh');
    const temporary = outputKeys.length ? await fsPromises.mkdtemp(path.join(os.tmpdir(), 'itt_bash_')) : undefined;
    const outFilePath = temporary ? path.join(temporary, 'output') : undefined;
    let result: TaskResult | undefined;
    try {
        result = await runProcess(interpreter, ['-c', prologue ? prologue + '\n' + config.command : config.command], {
            workingDir: config.workingDir,
            env: {...process.env, ...config.envVars, ...(outFilePath ? {_ITT_OUT: outFilePath} : {})},
            resultFile: outFilePath,
        }, options);
        if (!outFilePath) return result;
        let outData: Buffer;
        try {
            outData = await readResult(outFilePath, options.maxResultBytes);
        } catch (error) {
            if (error instanceof CodeProcessError) throw error;
            throw new AbortError(`code output '${outputKeys[0]}' not set`);
        }
        const rawOutputs = parseBashOutputFile(outData);
        result.typedOutputs = [];
        for (const [name, declaredType] of Object.entries(declaredOutputs)) {
            const raw = Object.prototype.hasOwnProperty.call(rawOutputs, name) ? rawOutputs[name] : null;
            result.typedOutputs.push(await validateBashOutput(name, raw, declaredType, config.workspaceDir ?? config.workingDir));
        }
        return result;
    } catch (error) {
        annotateFailure(error, result);
        throw error;
    } finally {
        if (temporary) await fsPromises.rm(temporary, {recursive: true, force: true});
    }
}

function annotateFailure(error: unknown, result?: TaskResult): void {
    if (!result) return;
    if (error instanceof CodeProcessError) {error.stdout = result.text; error.stderr = result.stderr;}
    if (error instanceof Error && result.exitCode !== 0) {
        const detail = result.stderr.trim();
        error.message += ` (process exited with exit code ${result.exitCode})${detail ? `\n${detail.length > 4000 ? "[last 4000 stderr characters]\n" : ""}${detail.slice(-4000)}` : ''}`;
    }
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
    const options = normalizeOptions(config);
    checkCancelled(options.signal);
    const {script, inputs, declaredOutputs, workspaceDir, workingDir} = config;
    const temporary = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'itt_python_'));
    const inputFilePath = path.join(temporary, 'input.json');
    const scriptFilePath = path.join(temporary, 'script.py');
    const outputFilePath = path.join(temporary, 'output.json');
    let result: TaskResult | undefined;
    try {
        await fsPromises.writeFile(inputFilePath, JSON.stringify(inputs), 'utf8');
        await fsPromises.writeFile(scriptFilePath, script, 'utf8');
        result = await runProcess('python3', [path.resolve(__dirname, '_itt_runner.py')], {
            workingDir, resultFile: Object.keys(declaredOutputs).length ? outputFilePath : undefined,
            env: {...process.env, _ITT_INPUT: inputFilePath, _ITT_SCRIPT_FILE: scriptFilePath,
                _ITT_OUTPUT: outputFilePath, _ITT_DECLARED_KEYS: JSON.stringify(Object.keys(declaredOutputs))},
        }, options);
        result.typedOutputs = [];
        // Ordinary exceptions and signals remain exit-code data for stream-only tasks.
        if (Object.keys(declaredOutputs).length === 0) return result;
        let outputJson: {outputs: Record<string, unknown>; not_serialisable: string[]};
        try {
            outputJson = JSON.parse((await readResult(outputFilePath, options.maxResultBytes)).toString('utf8'));
        } catch (error) {
            if (error instanceof CodeProcessError) throw error;
            throw new AbortError(`code output '${Object.keys(declaredOutputs)[0]}' not set`);
        }
        for (const [name, declaredType] of Object.entries(declaredOutputs)) {
            const isNotSerialisable = outputJson.not_serialisable.includes(name);
            const hasValue = Object.prototype.hasOwnProperty.call(outputJson.outputs, name);
            if (!hasValue && !isNotSerialisable) throw new AbortError(`code output '${name}' not set`);
            result.typedOutputs.push(await validatePythonOutput(name, outputJson.outputs[name], declaredType, workspaceDir, isNotSerialisable));
        }
        return result;
    } catch (error) {
        annotateFailure(error, result);
        throw error;
    } finally {
        await fsPromises.rm(temporary, {recursive: true, force: true});
    }
}

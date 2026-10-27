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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Output names become shell/Python variable names and must be plain identifiers. */
export function assertOutputNames(names: string[]): void {
    for (const name of names) {
        if (!IDENTIFIER.test(name)) {
            throw new AbortError(`code output name '${name}' must match ${IDENTIFIER.source}`);
        }
    }
}

/**
 * Generate a #!/bin/bash EXIT-trap prologue for capturing declared output vars.
 * Each declared output gets a capture block using `${VAR+set}` to distinguish
 * unset from set-but-empty. Values are written NUL-delimited:
 *   name\000+\000value\000   (set)
 *   name\000-\000            (unset)
 *
 * In Bash (not POSIX mode) user `trap ... EXIT` registrations are chained
 * after the capture instead of replacing it, and `exec` captures before the
 * shell is replaced. The capture rewrites the file each time it runs.
 *
 * Returns empty string if no declared outputs (no prologue needed).
 */
export function generateBashPrologue(outputKeys: string[]): string {
    if (outputKeys.length === 0) return '';
    assertOutputNames(outputKeys);
    const blocks = outputKeys
        .map(
            key =>
                `  if [ "\${${key}+set}" = set ]; then\n` +
                `    printf '%s\\000+\\000%s\\000' '${key}' "\${${key}}" >> "$_ITT_OUT"\n` +
                `  else\n` +
                `    printf '%s\\000-\\000' '${key}' >> "$_ITT_OUT"\n` +
                `  fi`,
        )
        .join('\n');
    return `#!/bin/bash
_itt_capture() {
  : > "$_ITT_OUT"
${blocks}
}
_itt_exit_action=
_itt_status() { return "$1"; }
_itt_on_exit() {
  _itt_exit_status=$?
  _itt_capture
  if [ -n "$_itt_exit_action" ]; then
    # Branches keep the original $? visible to the user's action, even under errexit.
    if _itt_status "$_itt_exit_status"; then eval "$_itt_exit_action"; else eval "$_itt_exit_action"; fi
    _itt_capture
  fi
}
trap '_itt_on_exit' EXIT
if [ -n "\${BASH_VERSION-}" ] && ! shopt -oq posix; then
  trap() {
    if [ "\${BASHPID:-$$}" != "$$" ] || [ "$#" -eq 0 ] || [ "$1" = -p ] || [ "$1" = -l ]; then
      builtin trap "$@"
      return
    fi
    [ "$1" != -- ] || shift
    local _itt_action=- _itt_signal _itt_rest=()
    if [ "$#" -gt 1 ]; then _itt_action=$1; shift; fi
    for _itt_signal in "$@"; do
      case "$_itt_signal" in
        0|EXIT|exit|SIGEXIT) if [ "$_itt_action" = - ]; then _itt_exit_action=; else _itt_exit_action=$_itt_action; fi ;;
        *) _itt_rest+=("$_itt_signal") ;;
      esac
    done
    [ "\${#_itt_rest[@]}" -eq 0 ] || builtin trap -- "$_itt_action" "\${_itt_rest[@]}"
  }
  shopt -s expand_aliases
  # Plain 'exec' (not 'builtin exec') keeps redirection-only forms persistent.
  alias exec='exec $(_itt_capture)'
fi
`;
}

// ── Subprocess environment ────────────────────────────────────────────────────

/** Host variables passed to every subprocess; credentials require explicit `env`. */
const INHERITED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TERM|SYSTEMROOT|COMSPEC|PATHEXT|WINDIR|TEMP|TMP)$/;

/** Variables that change how shells, loaders and interpreters start or resolve programs. */
const PROTECTED_ENV = /^(PATH|HOME|SHELL|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|IFS|CDPATH|GLOBIGNORE|PS4|PROMPT_COMMAND|TMPDIR|LD_.*|DYLD_.*|PYTHON.*|NODE_OPTIONS|NODE_PATH|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GIT_.*|BASH_FUNC_.*|_ITT_.*)$/;

function isProtectedEnvName(name: string): boolean {
    return PROTECTED_ENV.test(process.platform === 'win32' ? name.toUpperCase() : name);
}

/** Workflow inputs may not override variables that alter interpreter startup or program lookup. */
export function assertSafeEnvInputs(names: string[]): void {
    for (const name of names) {
        if (isProtectedEnvName(name)) {
            throw new AbortError(`code input '${name}' would override the protected environment variable ${name}; rename the input`);
        }
    }
}

/** Allowlisted host environment plus explicit host-supplied `env`; never the full host environment. */
export function subprocessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && INHERITED_ENV.test(process.platform === 'win32' ? name.toUpperCase() : name)) env[name] = value;
    }
    return Object.assign(env, extra);
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
    const escapes = (rel: string) => rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (escapes(relative)) {
        throw new AbortError(`code output '${name}': path must be under ITT_WORKSPACE`);
    }
    let stat, real;
    try {
        real = await fsPromises.realpath(abs);
        stat = await fsPromises.stat(real);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        throw new AbortError(`code output '${name}': path '${relative}' not found`);
    }
    // Symlinks may only resolve to targets that are themselves inside the workspace.
    if (escapes(path.relative(await fsPromises.realpath(workspace), real))) {
        throw new AbortError(`code output '${name}': path must resolve under ITT_WORKSPACE (symlink escapes are rejected)`);
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
    assertSafeEnvInputs(Object.keys(config.envVars));
    const prologue = generateBashPrologue(outputKeys);
    const interpreter = config.shell ?? (outputKeys.length ? 'bash' : 'sh');
    const temporary = outputKeys.length ? await fsPromises.mkdtemp(path.join(os.tmpdir(), 'itt_bash_')) : undefined;
    const outFilePath = temporary ? path.join(temporary, 'output') : undefined;
    let result: TaskResult | undefined;
    let outData: Buffer | undefined;
    let rawDiagnostic: unknown;
    try {
        result = await runProcess(interpreter, ['-c', prologue ? prologue + '\n' + config.command : config.command], {
            workingDir: config.workingDir,
            env: {...subprocessEnv(options.env), ...config.envVars, ...(outFilePath ? {_ITT_OUT: outFilePath} : {})},
            resultFile: outFilePath,
            consumeResult: outFilePath ? async () => {
                try {outData = await readResult(outFilePath, options.maxResultBytes);}
                catch (error) {
                    if (error instanceof CodeProcessError) throw error;
                    // Missing/invalid protocol errors are reported below with
                    // the completed process's exit code and stderr diagnostics.
                }
            } : undefined,
        }, options);
        if (!outFilePath) return result;
        if (!outData) throw new AbortError(`code output '${outputKeys[0]}' not set`);
        const rawOutputs = parseBashOutputFile(outData);
        rawDiagnostic = rawOutputs;
        result.typedOutputs = [];
        for (const [name, declaredType] of Object.entries(declaredOutputs)) {
            const raw = Object.prototype.hasOwnProperty.call(rawOutputs, name) ? rawOutputs[name] : null;
            result.typedOutputs.push(await validateBashOutput(name, raw, declaredType, config.workspaceDir ?? config.workingDir));
        }
        return result;
    } catch (error) {
        annotateFailure(error, result, rawDiagnostic);
        throw error;
    } finally {
        if (temporary) await fsPromises.rm(temporary, {recursive: true, force: true});
    }
}

function annotateFailure(error: unknown, result?: TaskResult, rawOutputs?: unknown): void {
    if (error instanceof Error) {
        const stdout = result?.text ?? (error instanceof CodeProcessError ? error.stdout : '');
        const stderr = result?.stderr ?? (error instanceof CodeProcessError ? error.stderr : '');
        const raw = rawOutputs === undefined ? undefined : JSON.stringify(rawOutputs);
        Object.assign(error, {diagnostics: {stdout: stdout.slice(-16000), stderr: stderr.slice(-16000),
            ...(result ? {exitCode: result.exitCode} : {}), ...(raw !== undefined ? {rawOutputs: raw.slice(0,64000)} : {}),
            truncated: stdout.length > 16000 || stderr.length > 16000 || (raw?.length ?? 0) > 64000}});
    }
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
        throw new AbortError(`code output '${name}': value is not JSON-serializable (NaN, Infinity and non-JSON types are rejected)`);
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
    assertOutputNames(Object.keys(declaredOutputs));
    const temporary = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'itt_python_'));
    const inputFilePath = path.join(temporary, 'input.json');
    const scriptFilePath = path.join(temporary, 'script.py');
    const outputFilePath = path.join(temporary, 'output.json');
    let result: TaskResult | undefined;
    let outputData: Buffer | undefined;
    let rawDiagnostic: unknown;
    try {
        await fsPromises.writeFile(inputFilePath, JSON.stringify(inputs), 'utf8');
        await fsPromises.writeFile(scriptFilePath, script, 'utf8');
        result = await runProcess('python3', [path.resolve(__dirname, '_itt_runner.py')], {
            workingDir, resultFile: Object.keys(declaredOutputs).length ? outputFilePath : undefined,
            env: {...subprocessEnv(options.env), _ITT_INPUT: inputFilePath, _ITT_SCRIPT_FILE: scriptFilePath,
                _ITT_OUTPUT: outputFilePath, _ITT_DECLARED_KEYS: JSON.stringify(Object.keys(declaredOutputs))},
            consumeResult: Object.keys(declaredOutputs).length ? async () => {
                try {outputData = await readResult(outputFilePath, options.maxResultBytes);}
                catch (error) {
                    if (error instanceof CodeProcessError) throw error;
                    // Preserve the existing missing-output diagnostic below.
                }
            } : undefined,
        }, options);
        result.typedOutputs = [];
        // Ordinary exceptions and signals remain exit-code data for stream-only tasks.
        if (Object.keys(declaredOutputs).length === 0) return result;
        let outputJson: {outputs: Record<string, unknown>; not_serialisable: string[]};
        try {
            if (!outputData) throw new Error('Missing output protocol');
            outputJson = JSON.parse(outputData.toString('utf8'));
        } catch (error) {
            if (error instanceof CodeProcessError) throw error;
            throw new AbortError(`code output '${Object.keys(declaredOutputs)[0]}' not set`);
        }
        rawDiagnostic = outputJson;
        for (const [name, declaredType] of Object.entries(declaredOutputs)) {
            const isNotSerialisable = outputJson.not_serialisable.includes(name);
            const hasValue = Object.prototype.hasOwnProperty.call(outputJson.outputs, name);
            if (!hasValue && !isNotSerialisable) throw new AbortError(`code output '${name}' not set`);
            result.typedOutputs.push(await validatePythonOutput(name, outputJson.outputs[name], declaredType, workspaceDir, isNotSerialisable));
        }
        return result;
    } catch (error) {
        annotateFailure(error, result, rawDiagnostic);
        throw error;
    } finally {
        await fsPromises.rm(temporary, {recursive: true, force: true});
    }
}

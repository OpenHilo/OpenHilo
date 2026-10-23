import {spawn} from 'child_process';
import {constants} from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import {StringDecoder} from 'string_decoder';
import {ExecutionError} from '@openhilo/runtime-contracts';
import {CodeProcessError, type CodeExecutionOptions, type CodeExecutionResult} from './types';

const DEFAULT_BYTES = 10 * 1024 * 1024;
export function normalizeOptions(options: CodeExecutionOptions) {
    const {timeoutMs, signal} = options;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_BYTES;
    const maxResultBytes = options.maxResultBytes ?? DEFAULT_BYTES;
    const killGraceMs = options.killGraceMs ?? 1000;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff)) {
        throw new RangeError('timeoutMs must be an integer between 1 and 2147483647');
    }
    for (const [name, value] of Object.entries({maxOutputBytes, maxResultBytes})) {
        if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
            throw new RangeError(`${name} must be a nonnegative safe integer or Infinity`);
        }
    }
    if (!Number.isInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > 0x7fffffff) {
        throw new RangeError('killGraceMs must be an integer between 0 and 2147483647');
    }
    return {timeoutMs, maxOutputBytes, maxResultBytes, killGraceMs, signal};
}

export function checkCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new CodeProcessError('cancelled', 'Code execution cancelled by host');
}

/** Bounds reads even if a file grows between stat and read; never opens a FIFO as a blocking read. */
export async function readResult(file: string, limit: number): Promise<Buffer> {
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Code result must be a regular file');
        if (stat.size > limit) throw new CodeProcessError('result_limit', `Code result exceeded maxResultBytes (${limit})`);
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
            const {bytesRead} = await handle.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            size += bytesRead;
            if (size > limit) throw new CodeProcessError('result_limit', `Code result exceeded maxResultBytes (${limit})`);
            chunks.push(chunk.subarray(0, bytesRead));
        }
        return Buffer.concat(chunks, size);
    } finally {await handle.close();}
}

/** One subprocess lifetime shared by shell and Python, including cancellation and pipe cleanup. */
export async function runProcess(command: string, args: string[], config: {
    workingDir: string; env: NodeJS.ProcessEnv; resultFile?: string;
}, options: ReturnType<typeof normalizeOptions>): Promise<CodeExecutionResult> {
    checkCancelled(options.signal);
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
        const grouped = process.platform !== 'win32';
        const child = spawn(command, args, {
            cwd: config.workingDir, env: config.env,
            detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let bytes = 0, closed = false, settled = false, checkingResult = false;
        let exitCode = 1;
        let failure: Error | undefined;
        let deadline: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined;
        let monitor: NodeJS.Timeout | undefined;

        const sendSignal = (signal: NodeJS.Signals) => {
            if (!child.pid) return;
            try {
                if (grouped) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                    // Preserve the primary failure and make failed cleanup visible.
                    if (failure) failure.message += `; ${signal} failed: ${(error as Error).message}`;
                }
            }
        };
        const decode = (chunks: Buffer[]) => {
            const decoder = new StringDecoder('utf8');
            const text = decoder.write(Buffer.concat(chunks));
            return text + (failure instanceof CodeProcessError && failure.reason === 'output_limit' ? '' : decoder.end());
        };
        const finish = () => {
            if (!closed || escalation || settled) return;
            settled = true;
            clearTimeout(deadline); clearInterval(monitor);
            options.signal?.removeEventListener('abort', cancel);
            const text = decode(stdout), errors = decode(stderr);
            if (failure) {
                if (failure instanceof CodeProcessError) {failure.stdout = text; failure.stderr = errors;}
                reject(failure);
            } else resolve({text, stderr: errors, files: [], exitCode,
                meta: {executor: 'code', startedAt, finishedAt: new Date().toISOString()}});
        };
        const stop = (error: Error) => {
            if (failure || settled) return;
            failure = error;
            sendSignal('SIGTERM');
            // Keep this timer even if the leader closes: descendants may ignore TERM
            // and have already closed their stdio. Never settle ahead of group cleanup.
            escalation = setTimeout(() => {
                sendSignal('SIGKILL');
                escalation = undefined;
                // A deliberately detached descendant can retain pipes beyond this
                // process group. Close our ends after escalation to bound the wait.
                child.stdout.destroy(); child.stderr.destroy();
                finish();
            }, options.killGraceMs);
        };
        const cancel = () => stop(new CodeProcessError('cancelled', 'Code execution cancelled by host'));
        const capture = (destination: Buffer[], chunk: Buffer) => {
            if (failure) return;
            const available = Math.max(0, options.maxOutputBytes - bytes);
            const kept = Math.min(available, chunk.length);
            if (kept) destination.push(Buffer.from(chunk.subarray(0, kept)));
            bytes += kept;
            if (chunk.length > available) stop(new CodeProcessError('output_limit',
                `Code stdout/stderr exceeded maxOutputBytes (${options.maxOutputBytes})`));
        };
        child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
        child.on('error', error => {
            failure ??= new ExecutionError(`Failed to spawn ${command}: ${error.message}`, 'unknown', 'code');
        });
        child.on('close', async (code, signal) => {
            exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1);
            // Fast writers can exit before the first polling tick. Check again
            // while we still own the process group, so their descendants are
            // also stopped rather than only rejecting the later file read.
            if (!failure && config.resultFile && options.maxResultBytes !== Infinity) {
                try {
                    if ((await fs.stat(config.resultFile)).size > options.maxResultBytes) {
                        stop(new CodeProcessError('result_limit', `Code result exceeded maxResultBytes (${options.maxResultBytes})`));
                    }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stop(error as Error);
                }
            }
            closed = true;
            finish();
        });
        options.signal?.addEventListener('abort', cancel, {once: true});
        if (options.signal?.aborted) cancel();
        if (options.timeoutMs !== undefined) deadline = setTimeout(() => stop(new CodeProcessError('timeout',
            `Code execution exceeded timeoutMs (${options.timeoutMs})`)), options.timeoutMs);
        if (config.resultFile && options.maxResultBytes !== Infinity) {
            const resultFile = config.resultFile;
            monitor = setInterval(async () => {
                if (checkingResult || settled || failure) return;
                checkingResult = true;
                try {
                    const stat = await fs.stat(resultFile);
                    if (stat.size > options.maxResultBytes) stop(new CodeProcessError('result_limit',
                        `Code result exceeded maxResultBytes (${options.maxResultBytes})`));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stop(error as Error);
                } finally {checkingResult = false;}
            }, 25);
        }
    });
}

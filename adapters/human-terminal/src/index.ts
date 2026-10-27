import {randomUUID} from 'node:crypto';
import {createInterface, type Interface} from 'node:readline';
import {
    type HumanExecutor,
    type HumanTaskHost,
    type HumanTaskRequest,
    validateHumanSubmission
} from '@openhilo/human-contracts';
import {HumanOutputError, parseHumanOutputValue} from '@openhilo/itt-contracts/human-output';

export interface TerminalHumanExecutorOptions {
    promptFn?: (prompt: string, signal?: AbortSignal) => Promise<string>;
    write?: (text: string) => void;
}

/**
 * One stdin reader shared by every task of an executor, so lines that arrive
 * together (piped input, typeahead) are queued rather than lost between tasks.
 * Stdin is paused, and a TTY returned to cooked mode, while no task is reading.
 */
class SharedLineReader {
    readonly readline: Interface;
    private readonly lines: string[] = [];
    private readonly waiters = new Set<{ resolve(line: string): void; reject(error: Error): void }>();
    private closed = false;
    private users = 0;

    constructor() {
        this.readline = createInterface({input: process.stdin, output: process.stdout});
        this.readline.on('line', line => {
            const waiter = this.waiters.values().next().value;
            if (!waiter) {
                this.lines.push(line);
                return;
            }
            this.waiters.delete(waiter);
            waiter.resolve(line);
        });
        this.readline.on('close', () => {
            this.closed = true;
            for (const waiter of this.waiters) waiter.reject(eofError());
            this.waiters.clear();
        });
        this.setActive(false);
    }

    acquire(): void {
        if (this.users++ === 0) this.setActive(true);
    }

    release(): void {
        if (--this.users === 0) this.setActive(false);
    }

    next(signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();
        if (this.lines.length) return Promise.resolve(this.lines.shift()!);
        if (this.closed) return Promise.reject(eofError());
        return new Promise((resolve, reject) => {
            // An abandoned read must not consume the next task's line.
            const abort = () => {
                this.waiters.delete(waiter);
                reject(signal.reason);
            };
            const waiter = {
                resolve: (line: string) => {
                    signal.removeEventListener('abort', abort);
                    resolve(line);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abort);
                    reject(error);
                },
            };
            this.waiters.add(waiter);
            signal.addEventListener('abort', abort, {once: true});
        });
    }

    close(): void {
        this.readline.close();
    }

    private setActive(active: boolean): void {
        if (this.closed) return;
        if (active) this.readline.resume();
        else this.readline.pause();
        const input = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
        if (this.readline.terminal && input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(active);
    }
}

function eofError(): Error {
    return new Error('Human terminal input closed (EOF) before submission');
}

/** Collect business results; closing stdin or aborting never submits a task. */
export class TerminalHumanExecutor implements HumanExecutor {
    readonly id = 'terminal';
    private reader?: SharedLineReader;

    constructor(private readonly options: TerminalHumanExecutorOptions = {}) {
    }

    /** Release stdin. Later presentations without `promptFn` observe EOF. */
    close(): void {
        this.reader?.close();
    }

    [Symbol.dispose](): void {
        this.close();
    }

    async present(request: HumanTaskRequest, host: HumanTaskHost): Promise<void> {
        host.signal.throwIfAborted();
        const write = this.options.write ?? ((text: string) => {
            process.stdout.write(text);
        });
        const reader = this.options.promptFn ? undefined : (this.reader ??= new SharedLineReader());
        const interrupted = new AbortController();
        const signal = AbortSignal.any([host.signal, interrupted.signal]);
        const onInterrupt = () => interrupted.abort(new DOMException('Human terminal input interrupted (SIGINT)', 'AbortError'));
        reader?.readline.on('SIGINT', onInterrupt);
        reader?.acquire();
        const prompt = this.options.promptFn ?? (async (text: string, promptSignal?: AbortSignal): Promise<string> => {
            write(text);
            return reader!.next(promptSignal ?? signal);
        });
        const ask = (text: string) => abortable(() => prompt(text, signal), signal);
        try {
            write(`${request.prompt}\n`);
            for (const [name, value] of Object.entries(request.inputs)) {
                write(`${name}:\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
            }
            const schema = Object.entries(request.outputs).map(([field, kind]) => `${field} (${kind})`).join(', ');
            write(`Outputs: ${schema || 'none'}\n`);
            const choose = async (labels: readonly string[]): Promise<number> => {
                labels.forEach((label, index) => write(`${index + 1}. ${label}\n`));
                for (; ;) {
                    const answer = (await ask('Choose a number: ')).trim();
                    const index = /^[1-9]\d*$/.test(answer) ? Number(answer) - 1 : -1;
                    if (index >= 0 && index < labels.length) return index;
                    write('Choose one of the listed numbers.\n');
                }
            };
            const values: Array<[string, string]> = [];
            if (!Object.keys(request.outputs).length) await choose(['Completed']);
            for (const [field, kind] of Object.entries(request.outputs)) {
                if (kind === 'boolean') {
                    write(`${field} (${kind}):\n`);
                    values.push([field, await choose(['Yes', 'No']) === 0 ? 'true' : 'false']);
                    continue;
                }
                for (; ;) {
                    const raw = await ask(`${field} (${kind}): `);
                    try {
                        parseHumanOutputValue(raw, kind, field);
                        values.push([field, raw]);
                        break;
                    } catch (error) {
                        if (!(error instanceof HumanOutputError)) throw error;
                        write(`${error.message}\n`);
                    }
                }
            }
            const submission = validateHumanSubmission(request, {
                taskId: request.taskId, submissionId: randomUUID(), outputs: Object.fromEntries(values),
            });
            signal.throwIfAborted();
            const receipt = await abortable(() => host.submit(submission), signal);
            if (receipt.status !== 'accepted' && receipt.status !== 'duplicate') {
                throw new Error(`Human submission ${receipt.status}: ${receipt.message ?? 'The task did not accept this result'}`);
            }
        } finally {
            reader?.readline.off('SIGINT', onInterrupt);
            reader?.release();
        }
    }
}

/** Also settles injected prompts that do not implement cancellation themselves. */
function abortable<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, {once: true});
        try {
            start().then(
                value => {
                    signal.removeEventListener('abort', abort);
                    resolve(value);
                },
                error => {
                    signal.removeEventListener('abort', abort);
                    reject(error);
                },
            );
        } catch (error) {
            signal.removeEventListener('abort', abort);
            reject(error);
        }
    });
}

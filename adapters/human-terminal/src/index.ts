import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
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

/** Collect business results; closing stdin or aborting never submits a task. */
export class TerminalHumanExecutor implements HumanExecutor {
    readonly id = 'terminal';

    constructor(private readonly options: TerminalHumanExecutorOptions = {}) {
    }

    async present(request: HumanTaskRequest, host: HumanTaskHost): Promise<void> {
        host.signal.throwIfAborted();
        const write = this.options.write ?? ((text: string) => {
            process.stdout.write(text);
        });
        const readline = this.options.promptFn ? undefined : createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const interrupted = new AbortController();
        const signal = AbortSignal.any([host.signal, interrupted.signal]);
        const onInterrupt = () => interrupted.abort(new DOMException('Human terminal input interrupted (SIGINT)', 'AbortError'));
        readline?.on('SIGINT', onInterrupt);
        const lines = readline?.[Symbol.asyncIterator]();
        const prompt = this.options.promptFn ?? (async (text: string): Promise<string> => {
            write(text);
            const line = await lines!.next();
            if (line.done) throw new Error('Human terminal input closed (EOF) before submission');
            return line.value;
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
            readline?.off('SIGINT', onInterrupt);
            readline?.close();
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

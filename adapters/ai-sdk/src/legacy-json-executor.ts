/** Temporary adapter for the old read-only JSON-completion configuration. No domain vocabulary. */
import OpenAI from 'openai';
import {
    type AiTaskExecutor,
    assertCanStart,
    createTaskExecution,
    type ExecutionHost,
    type TaskRequest,
} from '@openhilo/ai-contracts';

export interface LegacyJsonCompletionConfig {
    base_url: string;
    api_key: string;
    model: string
}

function completionErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isRetryableCompletionError(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    if (typeof status === 'number') {
        if (status === 408) return true;
        if (status >= 500 && status < 600) return true;
        return false;
    }

    if (err instanceof SyntaxError) return false;

    const msg = completionErrorMessage(err).toLowerCase();
    if (msg.includes('not valid json')) return false;

    if (msg.includes('timeout')) return true;
    if (msg.includes('connection')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('etimedout')) return true;
    if (msg.includes('socket hang up')) return true;
    if (msg.includes('enotfound')) return true;
    if (msg.includes('fetch failed')) return true;
    if (/\b5\d{2}\b/.test(msg)) return true;
    if (msg.includes('internal server error')) return true;
    if (msg.includes('bad gateway')) return true;
    if (msg.includes('service unavailable')) return true;
    if (msg.includes('gateway timeout')) return true;

    return false;
}

export class LegacyJsonCompletionExecutor implements AiTaskExecutor {
    readonly id = 'openhilo.legacy-json-completion';
    readonly capabilities = ['structured_output'] as const;

    constructor(private readonly config: LegacyJsonCompletionConfig) {
    }

    async start(request: TaskRequest, host: ExecutionHost) {
        assertCanStart(request, host, this.id, this.capabilities);
        const fields = Object.keys(request.output);
        if (fields.length !== 1 || request.output[fields[0]] !== 'json')
            throw new Error('Legacy JSON completion supports one JSON output field');
        const field = fields[0];
        return createTaskExecution(request, host, async (context) => {
            const attempts: string[] = [];
            for (let i = 1; i <= 2; i++) {
                context.signal.throwIfAborted();
                const attemptAbort = new AbortController();
                let rejectAbort!: (error: unknown) => void;
                const aborted = new Promise<never>((_, reject) => {
                    rejectAbort = reject;
                });
                const onAbort = () => {
                    attemptAbort.abort(context.signal.reason);
                    rejectAbort(context.signal.reason);
                };
                context.signal.addEventListener('abort', onAbort, {once: true});
                try {
                    const client = new OpenAI({baseURL: this.config.base_url, apiKey: this.config.api_key});
                    let timeoutId: ReturnType<typeof setTimeout> | undefined;
                    const response = await Promise.race([
                        aborted,
                        client.chat.completions.create(
                            {
                                model: this.config.model,
                                max_tokens: 256,
                                messages: [
                                    {
                                        role: 'system',
                                        content: [
                                            request.role ?? 'Return valid JSON for the requested task.',
                                            ...(request.constraints ?? []),
                                        ].join('\n'),
                                    },
                                    {
                                        role: 'user',
                                        content: [
                                            request.instruction,
                                            Object.keys(request.inputs).length
                                                ? `Inputs: ${JSON.stringify(request.inputs)}`
                                                : '',
                                            request.context?.length ? `Context: ${JSON.stringify(request.context)}` : '',
                                        ]
                                            .filter(Boolean)
                                            .join('\n\n'),
                                    },
                                ],
                            },
                            {signal: attemptAbort.signal}
                        ),
                        new Promise<never>((_, reject) => {
                            timeoutId = setTimeout(() => {
                                reject(new Error('JSON completion timeout'));
                                attemptAbort.abort('timeout');
                            }, 60_000);
                        }),
                    ]).finally(() => clearTimeout(timeoutId));
                    const text = response.choices[0]?.message?.content?.trim() ?? '';
                    const parsed = JSON.parse(text);
                    return {status: 'completed' as const, outputs: {[field]: parsed}, artifacts: []};
                } catch (err) {
                    attempts.push(completionErrorMessage(err));
                    context.signal.throwIfAborted();
                    if (i === 2 || !isRetryableCompletionError(err)) {
                        throw new Error(`JSON completion failed after ${i} attempts: ${attempts.join(' | ')}`);
                    }
                } finally {
                    context.signal.removeEventListener('abort', onAbort);
                    attemptAbort.abort('attempt finished');
                }
            }
            throw new Error('JSON completion failed: unreachable retry state');
        });
    }
}

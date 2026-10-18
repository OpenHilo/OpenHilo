// Direct SDK examples deliberately do not import Runtime, Codex, or a workspace host.
const {randomUUID} = require('node:crypto');
const OpenAI = require('openai').default;
const Anthropic = require('@anthropic-ai/sdk').default;
const {SdkTaskExecutor} = require('@openhilo/ai-sdk');

function createExampleExecutor(provider, {env = process.env, fetch} = {}) {
    if (!['openai', 'anthropic'].includes(provider)) throw new Error('Choose --provider openai or --provider anthropic explicitly');
    const prefix = provider === 'openai' ? 'OPENAI' : 'ANTHROPIC';
    const apiKey = env[`${prefix}_API_KEY`], model = env[`${prefix}_MODEL`];
    if (!apiKey?.trim()) throw new Error(`Set ${prefix}_API_KEY for the selected provider (never commit the key)`);
    if (!model?.trim()) throw new Error(`Set ${prefix}_MODEL explicitly; this example has no default paid model`);
    const client = provider === 'openai'
        ? new OpenAI({
            apiKey,
            baseURL: 'https://api.openai.com/v1',
            maxRetries: 0,
            organization: null,
            project: null, ...(fetch ? {fetch} : {})
        })
        : new Anthropic({
            apiKey,
            baseURL: 'https://api.anthropic.com',
            authToken: null,
            maxRetries: 0, ...(fetch ? {fetch} : {})
        });
    return new SdkTaskExecutor({
        profiles: {example: {provider, model, client, maxOutputTokens: 512}},
        defaultProfile: 'example',
        maxTurns: 4,
        maxToolCalls: 4,
        maxSessions: 1
    });
}

async function executeTextTask({executor, instruction, inputs, tools, write = text => process.stderr.write(text)}) {
    const request = {
        version: 1,
        taskId: randomUUID(),
        instruction,
        inputs,
        output: {summary: 'text'},
        requiredCapabilities: ['structured_output', ...(tools ? ['tools'] : [])]
    };
    const controller = new AbortController();
    let unexpectedQuestion = false, result, execution, lastPhase = '', lastElapsed = 0;
    const interrupt = () => {
        write('Stopping SDK attempt; waiting for cleanup.\n');
        controller.abort(new Error('Interrupted (SIGINT)'));
    };
    process.on('SIGINT', interrupt);
    try {
        write('Starting SDK task (no workspace is supplied).\n');
        execution = await executor.start(request, {
            attemptId: randomUUID(), signal: controller.signal, deadlineAt: new Date(Date.now() + 120000).toISOString(),
            ...(tools ? {tools} : {}),
            monitoring: {heartbeatMs: 2000, slowAfterMs: 15000, stalledAfterMs: 45000},
            onEvent(event) {
                if (event.type === 'question') {
                    unexpectedQuestion = true;
                    write('Unexpected AI question: this noninteractive example cannot answer; stopping.\n');
                    controller.abort(new Error('Unexpected AI question; no question handler configured'));
                }
                if (event.type === 'health') {
                    const h = event.health, key = `${h.phase}/${h.condition}`;
                    if (key !== lastPhase || h.elapsedMs - lastElapsed >= 10000) {
                        write(`SDK ${h.phase} · ${h.condition} · ${Math.floor(h.elapsedMs / 1000)}s\n`);
                        lastPhase = key;
                        lastElapsed = h.elapsedMs;
                    }
                }
            },
        });
        result = await execution.result;
        if (unexpectedQuestion) throw new Error('Unexpected AI question; no answer was submitted. The attempt stopped.');
        if (result.status === 'failed') throw new Error(`${result.error.code}: ${result.error.message}`);
        if (result.status === 'cancelled') throw new Error(`SDK cancelled: ${result.reason}`);
        write('SDK task completed; session will be released.\n');
        return result;
    } finally {
        process.off('SIGINT', interrupt);
        const session = result?.session ?? execution?.session;
        if (session) await executor.releaseSession?.(session);
    }
}

function printResult(result) {
    process.stdout.write(JSON.stringify({outputs: result.outputs, usage: result.usage ?? null}, null, 2) + '\n');
}

module.exports = {createExampleExecutor, executeTextTask, printResult};

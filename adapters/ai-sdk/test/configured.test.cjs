const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createSdkTaskExecutor} = require('../dist');

for (const provider of ['openai', 'anthropic']) {
    test(`${provider}: configured factory uses explicit credentials and ignores ambient SDK endpoint/auth defaults`, async () => {
        const names = ['OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'];
        const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
        const originalFetch = globalThis.fetch;
        for (const name of names) process.env[name] = name.endsWith('URL') ? 'https://must-not-contact.invalid' : 'ambient-value';
        let calls = 0;
        globalThis.fetch = async (url, init) => {
            calls++;
            assert.equal(String(url), provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
            const headers = new Headers(init.headers);
            assert.equal(headers.get('openai-organization'), null);
            assert.equal(headers.get('openai-project'), null);
            if (provider === 'openai') assert.equal(headers.get('authorization'), 'Bearer explicit-offline-key');
            else {
                assert.equal(headers.get('x-api-key'), 'explicit-offline-key');
                assert.equal(headers.get('authorization'), null);
            }
            const body = provider === 'openai'
                ? {
                    id: 'response',
                    status: 'completed',
                    output: [{
                        type: 'function_call',
                        call_id: 'done',
                        name: 'finish_task',
                        arguments: '{"answer":"yes"}'
                    }]
                }
                : {
                    id: 'message',
                    type: 'message',
                    role: 'assistant',
                    stop_reason: 'tool_use',
                    usage: {input_tokens: 1, output_tokens: 1},
                    content: [{type: 'tool_use', id: 'done', name: 'finish_task', input: {answer: 'yes'}}]
                };
            return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
        };
        try {
            const executor = createSdkTaskExecutor({
                primary: {
                    provider,
                    model: 'fixture-model',
                    apiKey: 'explicit-offline-key'
                }
            }, 'primary');
            assert.equal(calls, 0);
            const execution = await executor.start({
                    version: 1,
                    taskId: 'task',
                    instruction: 'Answer',
                    inputs: {},
                    output: {answer: 'text'},
                    requiredCapabilities: []
                },
                {
                    attemptId: 'attempt', signal: new AbortController().signal, onEvent() {
                    }
                });
            const result = await execution.result;
            assert.equal(result.status, 'completed', JSON.stringify(result));
            assert.equal(calls, 1);
            await executor.releaseSession(result.session);
        } finally {
            globalThis.fetch = originalFetch;
            for (const name of names) {
                if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
            }
        }
    });
}

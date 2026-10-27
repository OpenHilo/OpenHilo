const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const forbidden = () => {
    throw new Error('Live operations forbidden');
};
for (const name of ['node:http', 'node:https']) {
    require(name).request = forbidden;
    require(name).get = forbidden;
}
require('node:net').connect = forbidden;
require('node:net').createConnection = forbidden;
require('node:tls').connect = forbidden;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[name] = forbidden;
const initialFetch = global.fetch;
after(() => {
    global.fetch = initialFetch;
});
const {LegacyJsonCompletionExecutor} = require('@openhilo/ai-sdk/legacy-json-executor');

test('legacy JSON completion works through the independent SDK export with offline transport', async () => {
    let calls = 0;
    global.fetch = async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'offline');
        assert.match(body.messages[1].content, /catalogue/);
        return new Response(JSON.stringify({
            id: 'fixture',
            choices: [{message: {role: 'assistant', content: '["example:edit"]'}}]
        }), {status: 200, headers: {'content-type': 'application/json'}});
    };
    const executor = new LegacyJsonCompletionExecutor({
        base_url: 'http://offline.invalid/v1',
        api_key: 'fake',
        model: 'offline'
    });
    assert.equal(executor.id, 'openhilo.legacy-json-completion');
    const execution = await executor.start({
            version: 1,
            taskId: 'skills',
            instruction: 'Select from catalogue',
            inputs: {},
            output: {skills: 'json'},
            requiredCapabilities: ['structured_output']
        },
        {
            attemptId: 'attempt', signal: new AbortController().signal, onEvent() {
            }
        });
    assert.deepEqual((await execution.result).outputs, {skills: ['example:edit']});
    assert.equal(calls, 1);
});

test('legacy JSON completion does not read OpenAI organization, project or admin key from the environment', async t => {
    const saved = {};
    for (const [name, value] of Object.entries({OPENAI_ORG_ID: 'org-env', OPENAI_PROJECT_ID: 'proj-env', OPENAI_ADMIN_KEY: 'admin-env'})) {
        saved[name] = process.env[name];
        process.env[name] = value;
    }
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    let headers;
    global.fetch = async (_url, init) => {
        headers = new Headers(init.headers);
        return new Response(JSON.stringify({id: 'fixture', choices: [{message: {role: 'assistant', content: '{}'}}]}),
            {status: 200, headers: {'content-type': 'application/json'}});
    };
    const executor = new LegacyJsonCompletionExecutor({base_url: 'http://offline.invalid/v1', api_key: 'fake', model: 'offline'});
    const execution = await executor.start({
        version: 1, taskId: 'env', instruction: 'Select', inputs: {}, output: {value: 'json'},
        requiredCapabilities: ['structured_output']
    }, {attemptId: 'attempt', signal: new AbortController().signal, onEvent() {}});
    assert.equal((await execution.result).status, 'completed');
    assert.equal(headers.get('authorization'), 'Bearer fake');
    assert.equal(headers.get('openai-organization'), null);
    assert.equal(headers.get('openai-project'), null);
});

test('legacy JSON completion owns retries and does not truncate JSON at a tiny token cap', async () => {
    let calls = 0;
    global.fetch = async (_url, init) => {
        calls++;
        assert.ok(JSON.parse(init.body).max_tokens >= 1024);
        return new Response(JSON.stringify({error: {message: 'unavailable'}}), {
            status: 503,
            headers: {'content-type': 'application/json'}
        });
    };
    const executor = new LegacyJsonCompletionExecutor({base_url: 'http://offline.invalid/v1', api_key: 'fake', model: 'offline'});
    const execution = await executor.start({
        version: 1, taskId: 'skills', instruction: 'Select', inputs: {}, output: {skills: 'json'},
        requiredCapabilities: ['structured_output']
    }, {attemptId: 'attempt', signal: new AbortController().signal, onEvent() {}});
    const result = await execution.result;
    assert.equal(result.status, 'failed');
    assert.equal(calls, 2);
});

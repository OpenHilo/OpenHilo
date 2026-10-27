const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const OpenAI = require('openai').default;
const Anthropic = require('@anthropic-ai/sdk').default;
const {createToolHost} = require('@openhilo/tool-host');
const {SdkTaskExecutor} = require('../dist');

const request = (extra = {}) => ({
    version: 1,
    taskId: 'task',
    instruction: 'Do the work',
    inputs: {},
    output: {answer: 'text'},
    requiredCapabilities: [], ...extra
});
const host = (extra = {}) => ({
    attemptId: 'attempt', signal: new AbortController().signal, onEvent() {
    }, ...extra
});
const call = (id, name, args) => ({id, name, args});
const finish = (args = {answer: 'yes'}, id = 'finish') => [call(id, 'finish_task', args)];

function response(provider, calls, extra = {}) {
    if (provider === 'openai') return {
        id: 'resp', object: 'response', model: 'fixture-model', status: 'completed',
        output: calls.map(c => ({
            type: 'function_call',
            id: `fc_${c.id}`,
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.args),
            status: 'completed'
        })),
        usage: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
            input_tokens_details: {cached_tokens: 0},
            output_tokens_details: {reasoning_tokens: 0}
        }, ...extra
    };
    return {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: calls.map(c => ({type: 'tool_use', id: c.id, name: c.name, input: c.args})),
        usage: {input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0}, ...extra
    };
}

function harness(provider, steps, options = {}, clientOptions = {}) {
    const bodies = [];
    let calls = 0;
    const fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const step = steps[calls++];
        assert.ok(step !== undefined, 'Unexpected SDK network request: fixtures exhausted');
        const result = typeof step === 'function' ? await step(body, init) : step;
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(Array.isArray(result) ? response(provider, result) : result), {
            status: 200,
            headers: {'content-type': 'application/json'}
        });
    };
    const client = provider === 'openai' ? new OpenAI({
        ...clientOptions,
        apiKey: 'offline-test-key',
        fetch
    }) : new Anthropic({...clientOptions, apiKey: 'offline-test-key', fetch});
    const executor = new SdkTaskExecutor({
        profiles: {test: {provider, model: 'fixture-model', client}},
        defaultProfile: 'test', ...options
    });
    return {executor, bodies, calls: () => calls, client};
}

test('explicit deployment identity binds session references and rejects a different configuration', async () => {
    const h = harness('openai', [finish(), finish({answer: 'continued'}, 'second')], {id: 'sdk-config:v1'});
    const result = await (await h.executor.start(request(), host())).result;
    assert.equal(result.session.executorId, 'sdk-config:v1');
    const other = harness('openai', [], {id: 'sdk-config:v2'});
    await assert.rejects(other.executor.start(request({continuation: result.session}), host()), /executor/i);
    const next = await (await h.executor.start(request({continuation: result.session}), host())).result;
    assert.equal(next.outputs.answer, 'continued');
    await h.executor.releaseSession(next.session);
    assert.equal(other.calls(), 0);
    assert.throws(() => harness('openai', [], {id: ' '}), /identity/);
});

for (const provider of ['openai', 'anthropic']) {
    test(`${provider}: official SDK, clarification, host tool, real file writes, usage and continuation`, async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-task-'));
        const marker = provider === 'openai' ? {
                type: 'reasoning',
                id: 'reasoning',
                summary: [],
                encrypted_content: 'opaque-fixture'
            }
            : {type: 'thinking', thinking: 'fixture-native-state', signature: 'opaque-fixture'};
        const first = response(provider, [call('ask', 'ask_user', {
            prompt: 'Which name?',
            answer: 'text',
            options: [{label: 'Suggested', value: 'suggested'}]
        })]);
        first[provider === 'openai' ? 'output' : 'content'].unshift(marker);
        const h = harness(provider, [first, [call('lookup', 'lookup', {id: 'chosen'}), call('write', 'workspace_write', {
            path: 'generated/workflow.ts',
            content: 'first'
        })],
            finish({answer: 'done', source: 'generated/workflow.ts'}),
            [call('repair-read', 'workspace_read', {path: 'generated/workflow.ts'}), call('repair-write', 'workspace_write', {
                path: 'generated/workflow.ts',
                content: 'fixed'
            })],
            finish({answer: 'repaired', source: 'generated/workflow.ts'}, 'finish-repair')]);
        const events = [];
        let asked;
        const question = new Promise(resolve => {
            asked = resolve;
        });
        let toolsInvoked = 0;
        const tools = createToolHost([{
            name: 'lookup',
            description: 'Lookup',
            inputSchema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']},
            readOnly: true,
            async handler(args) {
                toolsInvoked++;
                return {id: args.id};
            }
        }]);
        const live = host({
            workspace: {id: dir, uri: pathToFileURL(dir).href}, tools, onEvent(event) {
                events.push(event);
                if (event.type === 'question') asked(event.question);
            }
        });
        try {
            const task = request({
                output: {answer: 'text', source: 'file'},
                context: [{namespace: 'example', version: 1, data: {hint: 'preserve'}}],
                role: 'Writer',
                constraints: ['Keep context']
            });
            const execution = await h.executor.start(task, live);
            const q = await question;
            assert.equal(execution.state, 'waiting_for_input');
            assert.equal(await execution.answer(q.id, 'custom answer'), 'accepted');
            assert.equal(await execution.answer(q.id, 'custom answer'), 'duplicate');
            const result = await execution.result;
            assert.equal(result.status, 'completed');
            assert.equal(toolsInvoked, 1);
            assert.equal(await fs.readFile(path.join(dir, 'generated/workflow.ts'), 'utf8'), 'first');
            assert.equal(result.session.executorId, 'openhilo.ai-sdk');
            assert.equal(result.artifacts[0].origin, 'openhilo.ai-sdk');
            assert.equal(result.artifacts[0].uri, pathToFileURL(await fs.realpath(path.join(dir, 'generated/workflow.ts'))).href);
            assert.deepEqual(result.usage, {inputTokens: 9, outputTokens: 6, measurement: 'reported'});
            assert.equal(events.filter(e => e.type === 'terminal').length, 1);
            assert.ok(JSON.stringify(h.bodies[1]).includes('opaque-fixture'));
            assert.ok(JSON.stringify(h.bodies[1]).includes('custom answer'));
            if (provider === 'openai') {
                assert.equal(h.bodies[0].store, false);
                assert.deepEqual(h.bodies[0].include, ['reasoning.encrypted_content']);
            } else {
                const messages = h.bodies[2].messages;
                assert.deepEqual(messages.at(-1).content.map(item => item.tool_use_id), ['lookup', 'write']);
                assert.equal(messages.at(-2).role, 'assistant');
            }
            const continuation = await h.executor.start({
                ...task,
                instruction: 'Compiler diagnostics: fix the source',
                continuation: result.session
            }, host({...live, attemptId: 'repair'}));
            const repaired = await continuation.result;
            assert.equal(repaired.status, 'completed');
            assert.equal(await fs.readFile(path.join(dir, 'generated/workflow.ts'), 'utf8'), 'fixed');
            assert.ok(JSON.stringify(h.bodies[3]).includes('Compiler diagnostics'));
            assert.ok(JSON.stringify(h.bodies[3]).includes('accepted'));
            await h.executor.releaseSession(repaired.session);
            await assert.rejects(h.executor.start({...task, continuation: repaired.session}, live), /expired/);
        } finally {
            await fs.rm(dir, {recursive: true, force: true});
        }
    });

    test(`${provider}: SDK errors map without automatic retries`, async () => {
        for (const [status, code, expected] of [[401, 'authentication_error', 'authentication_failed'], [429, 'rate_limit_error', 'rate_limited'], [429, 'insufficient_quota', 'quota_exhausted'], [500, 'server_error', 'executor_failed']]) {
            const h = harness(provider, [new Response(JSON.stringify({
                error: {
                    message: 'private-request-details',
                    type: code,
                    code
                }
            }), {status, headers: {'content-type': 'application/json'}})]);
            const result = await (await h.executor.start(request(), host())).result;
            assert.equal(result.status, 'failed');
            assert.equal(result.error.code, expected);
            assert.equal(result.error.safeToReplay, true);
            assert.equal(h.calls(), 1);
            assert.ok(!JSON.stringify(result).includes('private-request-details'));
        }
    });

    test(`${provider}: SDK request receives abort and task has one terminal outcome`, async () => {
        let ready;
        const started = new Promise(resolve => {
            ready = resolve;
        });
        const h = harness(provider, [async (_body, init) => {
            ready();
            await new Promise(resolve => init.signal.addEventListener('abort', resolve, {once: true}));
            throw new DOMException('aborted', 'AbortError');
        }]);
        const events = [];
        const execution = await h.executor.start(request(), host({onEvent: e => events.push(e)}));
        await started;
        await execution.cancel('stop');
        assert.equal((await execution.result).status, 'cancelled');
        assert.equal(h.calls(), 1);
        assert.equal(events.filter(e => e.type === 'terminal').length, 1);
    });

    test(`${provider}: SDK network timeout is classified once without credential leakage`, async () => {
        const h = harness(provider, [async (_body, init) => {
            await new Promise(resolve => init.signal.addEventListener('abort', resolve, {once: true}));
            throw new DOMException('private-network-details offline-test-key', 'AbortError');
        }], {}, {timeout: 30});
        const events = [];
        const result = await (await h.executor.start(request(), host({onEvent: event => events.push(event)}))).result;
        assert.equal(result.status, 'failed');
        assert.equal(result.error.code, 'timeout');
        assert.equal(result.error.retryable, true);
        assert.equal(h.calls(), 1);
        assert.equal(events.filter(event => event.type === 'terminal').length, 1);
        assert.doesNotMatch(JSON.stringify({result, events}), /private-network-details|offline-test-key/);
    });

    test(`${provider}: unexpected event-stream response cannot become successful output`, async () => {
        const h = harness(provider, [new Response('event: error\ndata: {"error":"private-stream-details"}\n\ndata: {broken\n\n', {
            status: 200, headers: {'content-type': 'text/event-stream'},
        })]);
        const events = [];
        const result = await (await h.executor.start(request(), host({onEvent: event => events.push(event)}))).result;
        assert.equal(result.status, 'failed');
        // OpenAI's SDK rejects this body before adapter validation; Anthropic returns
        // it to the adapter, where it lacks the required completion status.
        assert.equal(result.error.code, provider === 'openai' ? 'executor_failed' : 'invalid_output');
        assert.equal(h.calls(), 1);
        assert.equal(events.filter(event => event.type === 'terminal').length, 1);
        assert.doesNotMatch(JSON.stringify({result, events}), /private-stream-details|offline-test-key/);
        assert.notEqual(h.bodies[0].stream, true, 'the current adapter uses complete responses, not streaming');
    });
}

test('unknown profile, reserved tools, hard budgets and reconnect fail before SDK access', async () => {
    const h = harness('openai', []);
    await assert.rejects(h.executor.start(request({profile: 'missing'}), host()), /Unknown SDK profile/);
    await assert.rejects(h.executor.start(request({budget: {mode: 'hard', maxUsd: 1}}), host()), /hard_budget/);
    await assert.rejects(h.executor.start(request({requiredCapabilities: ['reconnect']}), host()), /reconnect/);
    await assert.rejects(h.executor.start(request(), host({
        tools: {
            definitions: [{
                name: 'finish_task',
                description: 'bad',
                inputSchema: {type: 'object'}
            }], async invoke() {
            }
        }
    })), /reserved/);
    assert.equal(h.calls(), 0);
});

test('invalid output, text-only completion, truncation and mixed finish/tool batches never succeed', async () => {
    for (const [provider, step] of [
        ['openai', finish({answer: 12})], ['openai', []], ['anthropic', []],
        ['openai', response('openai', finish(), {status: 'incomplete'})],
        ['anthropic', response('anthropic', finish(), {stop_reason: 'max_tokens'})],
        ['openai', [...finish(), call('also', 'write', {})]],
    ]) {
        const h = harness(provider, [step]);
        const result = await (await h.executor.start(request(), host())).result;
        assert.equal(result.status, 'failed');
        assert.equal(result.error.code, 'invalid_output');
    }
});

test('safe tool failures can be corrected but uncertain writes stop without another model request', async () => {
    let writes = 0;
    const tools = createToolHost([{
        name: 'write',
        description: 'write',
        inputSchema: {type: 'object', properties: {x: {type: 'number'}}, required: ['x']},
        async handler() {
            writes++;
            throw new Error('connection lost after write');
        }
    }]);
    const h = harness('openai', [[call('invalid', 'write', {})], [call('write', 'write', {x: 1})], finish()]);
    const result = await (await h.executor.start(request(), host({tools}))).result;
    assert.equal(result.error.code, 'outcome_unknown');
    assert.equal(result.error.safeToReplay, false);
    assert.equal(writes, 1);
    assert.equal(h.calls(), 2);
    assert.ok(JSON.stringify(h.bodies[1]).includes('invalid_request'));
});

test('duplicate provider call IDs cannot repeat a host side effect', async () => {
    let writes = 0;
    const tools = createToolHost([{
        name: 'write', description: '', inputSchema: {type: 'object'}, async handler() {
            return ++writes;
        }
    }]);
    const h = harness('anthropic', [[call('same', 'write', {})], [call('same', 'write', {})]]);
    const result = await (await h.executor.start(request(), host({tools}))).result;
    assert.equal(writes, 1);
    assert.equal(result.error.code, 'invalid_output');
    assert.equal(result.error.safeToReplay, false);
});

test('turn limits, call limits and pre-cancellation do not leak retained session capacity', async () => {
    const h = harness('openai', [[call('unknown', 'missing', {})], finish()], {maxTurns: 1, maxSessions: 1});
    assert.equal((await (await h.executor.start(request(), host())).result).error.code, 'executor_failed');
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await (await h.executor.start(request(), host({signal: aborted.signal}))).result).status, 'cancelled');
    const success = await (await h.executor.start(request(), host())).result;
    assert.equal(success.status, 'completed');
    await assert.rejects(h.executor.start(request(), host()), /Release idle/);
    await h.executor.releaseSession(success.session);
    const limited = harness('anthropic', [[call('a', 'missing', {}), call('b', 'missing', {})]], {maxToolCalls: 1});
    assert.equal((await (await limited.executor.start(request(), host())).result).error.code, 'executor_failed');
});

test('workspace symlink escapes, missing artifacts and remote workspaces are rejected', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-paths-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-outside-'));
    try {
        await fs.symlink(outside, path.join(dir, 'escape'));
        const live = host({workspace: {id: dir, uri: pathToFileURL(dir).href}});
        const h = harness('openai', [[call('write', 'workspace_write', {path: 'escape/secret', content: 'bad'})]]);
        assert.equal((await (await h.executor.start(request(), live)).result).status, 'failed');
        assert.deepEqual(await fs.readdir(outside), []);
        const missing = harness('anthropic', [finish({source: 'missing.ts'})]);
        assert.equal((await (await missing.executor.start(request({output: {source: 'file'}}), live)).result).error.code, 'invalid_output');
        await assert.rejects(h.executor.start(request(), host({
            workspace: {
                id: 'remote',
                uri: 'https://remote'
            }
        })), /local/);
    } finally {
        await fs.rm(dir, {recursive: true, force: true});
        await fs.rm(outside, {recursive: true, force: true});
    }
});

test('partial usage remains unknown rather than reporting missing tokens as zero', async () => {
    const h = harness('openai', [response('openai', [call('missing', 'unknown_tool', {})], {usage: undefined}), finish()]);
    const events = [];
    const result = await (await h.executor.start(request(), host({onEvent: event => events.push(event)}))).result;
    assert.equal(result.status, 'completed');
    assert.equal(result.usage.inputTokens, undefined);
    assert.equal(result.usage.outputTokens, undefined);
    assert.equal(events.filter(event => event.type === 'usage').length, 1);
});

test('a busy continuation cannot fork or be released while running', async () => {
    let ready;
    const waiting = new Promise(resolve => {
        ready = resolve;
    });
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const h = harness('openai', [finish(), async () => {
        ready();
        await gate;
        return finish({answer: 'continued'}, 'finish-2');
    }]);
    const first = await (await h.executor.start(request(), host())).result;
    const continued = await h.executor.start(request({continuation: first.session}), host());
    await waiting;
    await assert.rejects(h.executor.start(request({continuation: first.session}), host()), /active attempt/);
    await assert.rejects(h.executor.releaseSession(first.session), /active SDK task/);
    release();
    assert.equal((await continued.result).status, 'completed');
    await h.executor.releaseSession(first.session);
});

test('workspace root cannot be treated as a file and path traversal never writes outside', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-root-write-'));
    const dir = path.join(parent, 'workspace');
    await fs.mkdir(dir);
    try {
        for (const target of ['.', '../outside']) {
            const h = harness('openai', [[call('write', 'workspace_write', {path: target, content: 'not allowed'})]]);
            const result = await (await h.executor.start(request(), host({
                workspace: {
                    id: dir,
                    uri: pathToFileURL(dir).href
                }
            }))).result;
            assert.equal(result.status, 'failed');
            assert.deepEqual(await fs.readdir(parent), ['workspace']);
            assert.deepEqual(await fs.readdir(dir), []);
        }
    } finally {
        await fs.rm(parent, {recursive: true, force: true});
    }
});

test('continuation profile and workspace mismatches are rejected before a new request', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-session-scope-'));
    try {
        const h = harness('openai', [finish()]);
        const executor = new SdkTaskExecutor({
            defaultProfile: 'a', profiles: {
                a: {provider: 'openai', model: 'a', client: h.client},
                b: {provider: 'openai', model: 'b', client: h.client},
            }
        });
        const live = host({workspace: {id: 'original', uri: pathToFileURL(dir).href}});
        const result = await (await executor.start(request(), live)).result;
        await assert.rejects(executor.start(request({continuation: result.session, profile: 'b'}), live), /mismatch/);
        await assert.rejects(executor.start(request({continuation: result.session}), host({
            workspace: {
                id: 'changed',
                uri: live.workspace.uri
            }
        })), /workspace/);
        assert.equal(h.calls(), 1);
        await executor.releaseSession(result.session);
    } finally {
        await fs.rm(dir, {recursive: true, force: true});
    }
});

test('malformed native call IDs are rejected before any host handler runs', async () => {
    let calls = 0;
    const tools = createToolHost([{
        name: 'write', description: '', inputSchema: {type: 'object'}, async handler() {
            return ++calls;
        }
    }]);
    const invalid = response('anthropic', [call(42, 'write', {})]);
    const h = harness('anthropic', [invalid]);
    const result = await (await h.executor.start(request(), host({tools}))).result;
    assert.equal(result.error.code, 'invalid_output');
    assert.equal(calls, 0);
});

for (const provider of ['openai', 'anthropic']) {
    test(`${provider}: configured active budget pauses for a question and resumes once`, async () => {
        let resolveQuestion;
        const question = new Promise(resolve => { resolveQuestion = resolve; });
        const h = harness(provider, [[call('ask', 'ask_user', {prompt: 'Continue?', answer: 'text'})], finish()], {timeoutMs: 500});
        const execution = await h.executor.start(request(), host({onEvent(event) { if (event.type === 'question') resolveQuestion(event.question); }}));
        const q = await question;
        const remaining = execution.health.remainingMs;
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.equal(execution.state, 'waiting_for_input');
        assert.equal(execution.health.remainingMs, remaining);
        assert.equal(await execution.answer(q.id, 'yes'), 'accepted');
        assert.equal((await execution.result).status, 'completed');
        assert.equal(h.calls(), 2);
    });
    test(`${provider}: active timeout aborts the pending HTTP call without replay`, async () => {
        let aborted = false;
        const h = harness(provider, [async (_body, init) => {
            await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, {once: true}));
        }], {timeoutMs: 100});
        const execution = await h.executor.start(request(), host());
        const result = await execution.result;
        assert.equal(result.status, 'failed');
        assert.equal(result.error.code, 'timeout');
        assert.equal(result.error.safeToReplay, false);
        assert.equal(aborted, true);
        assert.equal(h.calls(), 1);
    });
}

for (const provider of ['openai','anthropic']) test(`${provider}: nested output shape is sent to the model and enforced without retry`,async()=>{
  const outputShapes={plan:{type:'object',properties:{urls:{shape:{type:'array',items:{type:'text'}}}}}};
  const h=harness(provider,[finish({plan:{urls:[42]}})]);
  const result=await(await h.executor.start(request({output:{plan:'json'},outputShapes}),host())).result;
  assert.equal(result.status,'failed');assert.equal(result.error.code,'invalid_output');
  assert.match(result.error.message,/plan.urls\[0\]/);assert.equal(h.calls(),1);
  assert.ok(JSON.stringify(h.bodies).includes('outputShapes'));
});

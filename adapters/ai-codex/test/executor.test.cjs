const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {pathToFileURL} = require('node:url');
const {CodexTaskExecutor} = require('../dist');

function setup(t, instruction = 'ok', patch = {}, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const events = [];
    const controller = new AbortController();
    const host = {
        attemptId: 'attempt',
        signal: controller.signal,
        workspace: {id: 'workspace', uri: pathToFileURL(dir).href},
        onEvent: e => events.push(e)
    };
    const request = {
        version: 1,
        taskId: 'task',
        instruction,
        inputs: {},
        output: {answer: 'text'},
        requiredCapabilities: [], ...patch
    };
    const executor = new CodexTaskExecutor({
        cliPath: path.join(__dirname, 'fixtures/codex.cjs'),
        timeoutMs: 5000, ...options
    });
    return {dir, events, host, request, executor, controller};
}

test('maps structured output, cumulative turn usage and a workspace-bound continuation', async t => {
    const s = setup(t, 'ok', {output: {answer: 'text', data: 'json'}});
    const first = await s.executor.start(s.request, s.host);
    const result = await first.result;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.deepEqual(result.outputs, {answer: 'ok', data: {nested: [1, true]}});
    assert.deepEqual(result.usage, {inputTokens: 70, outputTokens: 30, measurement: 'reported'});
    assert.equal(result.session.executorId, 'openhilo.codex');
    assert.equal(result.session.workspaceId, 'workspace');
    assert.deepEqual(first.session, result.session);
    assert.deepEqual(s.events.filter(e => e.type === 'phase').map(e => e.phase), ['starting', 'model', 'cleanup']);
    const next = await s.executor.start({...s.request, continuation: result.session}, {...s.host, attemptId: 'second'});
    assert.equal((await next.result).status, 'completed');
    assert.equal(s.events.filter(e => e.type === 'terminal').length, 2);
});
test('start and resume send the current output envelope contract as developer instructions', async t => {
    const profile = {title: 'Example', labels: {category: 'notes'}};
    const s = setup(t, 'output-envelope', {
        role: 'Return raw JSON such as {"title":"Example","labels":{"category":"notes"}}.',
        output: {profile: 'json'}
    });
    const first = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(first.status, 'completed', JSON.stringify(first));
    assert.deepEqual(first.outputs, {profile});
    const second = await (await s.executor.start({
        ...s.request,
        output: {classification: 'json'},
        continuation: first.session
    }, {...s.host, attemptId: 'second'})).result;
    assert.equal(second.status, 'completed', JSON.stringify(second));
    assert.deepEqual(second.outputs, {classification: profile});
    const messages = fs.readFileSync(path.join(s.dir, 'envelope-protocol.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(messages.map(m => m.method), ['thread/start', 'thread/resume']);
    for (const [index, contract] of [{profile: 'json'}, {classification: 'json'}].entries()) {
        const instruction = messages[index].developerInstructions;
        assert.equal(typeof instruction, 'string');
        assert.match(instruction, /resultJson/);
        assert.ok(instruction.includes(JSON.stringify(contract)), instruction);
        assert.match(instruction, /never unwrap/i);
        assert.match(instruction, /role.*example/i);
    }
});
test('raw single-field JSON output still fails validation without retry', async t => {
    const s = setup(t, 'raw-profile', {output: {profile: 'json'}});
    const result = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'invalid_output');
    assert.equal(result.error.safeToReplay, false);
    assert.equal(s.events.filter(e => e.type === 'terminal').length, 1);
    assert.equal(fs.readFileSync(path.join(s.dir, 'envelope-protocol.jsonl'), 'utf8').trim().split('\n').length, 1);
});
test('invokes the real host tool and forwards its result', async t => {
    const s = setup(t, 'tools');
    let calls = 0;
    s.host.tools = {
        definitions: [{name: 'echo', description: 'Echo', inputSchema: {type: 'object'}}],
        async invoke(call) {
            calls++;
            assert.deepEqual(call.arguments, {value: 'x'});
            return {ok: true, output: {echo: 'host-result'}};
        }
    };
    const result = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.outputs.answer, 'host-result');
    assert.equal(calls, 1);
    assert.deepEqual(s.events.filter(e => e.type.startsWith('tool_')).map(e => [e.type, e.tool]), [['tool_started', 'echo'], ['tool_finished', 'echo']]);
});
test('questions use the existing answer lifecycle, including duplicate receipts', async t => {
    const s = setup(t, 'question');
    const execution = await s.executor.start(s.request, s.host);
    for (let i = 0; i < 100 && !s.events.some(e => e.type === 'question'); i++) await new Promise(r => setTimeout(r, 10));
    const q = s.events.find(e => e.type === 'question');
    assert.ok(q);
    assert.equal(execution.state, 'waiting_for_input');
    assert.equal(await execution.answer(q.question.id, 'Alice'), 'accepted');
    assert.equal(await execution.answer(q.question.id, 'Alice'), 'duplicate');
    assert.equal((await execution.result).outputs.answer, 'Alice');
});
for (const instruction of ['bad-json', 'wrong-kind', 'crash', 'failed']) test(`rejects ${instruction} without replaying`, async t => {
    const s = setup(t, instruction);
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.status, 'failed');
    assert.equal(r.error.safeToReplay, false);
    assert.equal(r.error.code, instruction === 'crash' ? 'outcome_unknown' : instruction === 'failed' ? 'quota_exhausted' : 'invalid_output');
    assert.equal(s.events.filter(e => e.type === 'terminal').length, 1);
});
test('cancel waits for process cleanup and emits one terminal', async t => {
    const s = setup(t, 'hang');
    const e = await s.executor.start(s.request, s.host);
    await new Promise(r => setTimeout(r, 60));
    await e.cancel('stop');
    assert.equal((await e.result).status, 'cancelled');
    assert.equal(s.events.filter(e => e.type === 'terminal').length, 1);
});
test('default timeout bounds an unresponsive task', async t => {
    const s = setup(t, 'hang', {}, {timeoutMs: 100});
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'timeout');
});
test('rejects unsupported budgets and wrong-workspace sessions before spawning', async t => {
    const s = setup(t);
    await assert.rejects(s.executor.start({...s.request, budget: {mode: 'hard', maxUsd: 1}}, s.host), /hard_budget/);
    const r = await (await s.executor.start(s.request, s.host)).result;
    await assert.rejects(s.executor.start({...s.request, continuation: r.session}, {
        ...s.host,
        workspace: {...s.host.workspace, id: 'other'}
    }), /workspace/);
});
test('does not approve privilege escalation requested by the child', async t => {
    const s = setup(t, 'approval');
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.outputs.answer, 'decline');
});
test('ignores cross-thread requests without invoking host tools', async t => {
    const s = setup(t, 'wrong-thread');
    let calls = 0;
    s.host.tools = {
        definitions: [{name: 'echo', description: 'Echo', inputSchema: {type: 'object'}}], async invoke() {
            calls++;
            return {ok: true, output: null};
        }
    };
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.outputs.answer, 'rejected');
    assert.equal(calls, 0);
});
test('timeout interrupts a stalled initialization promptly', async t => {
    const s = setup(t, 'ok', {}, {cliPath: path.join(__dirname, 'fixtures/hang.cjs'), timeoutMs: 80});
    const before = Date.now();
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'timeout');
    assert.ok(Date.now() - before < 1500);
});

test('a crashed CLI cancels and drains its outstanding host tool before settling', async t => {
    const s = setup(t, 'crash-tool');
    let cancelled = false, drained = false;
    s.host.tools = {
        definitions: [{name: 'slow', description: 'Slow', inputSchema: {type: 'object'}}], invoke(_call, signal) {
            return new Promise(resolve => {
                signal.addEventListener('abort', () => {
                    cancelled = true;
                    setTimeout(() => {
                        drained = true;
                        resolve({
                            ok: false,
                            error: {code: 'tool_failed', message: 'cancelled', retryable: false, safeToReplay: false}
                        })
                    }, 30)
                }, {once: true});
            });
        }
    };
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.status, 'failed');
    assert.equal(cancelled, true);
    assert.equal(drained, true);
});

test('terminal-triggered continuation retains its reservation after the previous result settles', async t => {
    const s = setup(t);
    let continuation;
    s.host.onEvent = e => {
        if (e.type === 'terminal' && e.result.status === 'completed') {
            continuation = s.executor.start({
                ...s.request,
                instruction: 'hang',
                continuation: e.result.session
            }, {
                ...s.host, attemptId: 'second', onEvent: () => {
                }
            });
        }
    };
    const first = await s.executor.start(s.request, s.host);
    const result = await first.result;
    const second = await continuation;
    try {
        await assert.rejects(s.executor.start({
            ...s.request,
            instruction: 'hang',
            continuation: result.session
        }, {
            ...s.host, attemptId: 'third', onEvent: () => {
            }
        }), /active attempt/);
    } finally {
        await second.cancel('test cleanup');
    }
});

test('a pre-cancelled continuation releases its reservation', async t => {
    const s = setup(t);
    const result = await (await s.executor.start(s.request, s.host)).result;
    const request = {...s.request, continuation: result.session};
    const cancelled = await s.executor.start(request, {...s.host, attemptId: 'cancelled', signal: AbortSignal.abort()});
    assert.equal((await cancelled.result).status, 'cancelled');
    const next = await s.executor.start(request, {...s.host, attemptId: 'next'});
    assert.equal((await next.result).status, 'completed');
});

for (const failure of ['unsafe-result', 'throw']) test(`a ${failure} host failure stops Codex before another tool can run`, async t => {
    const s = setup(t, 'tool-recovery');
    let calls = 0;
    s.host.tools = {
        definitions: [{name: 'write', description: 'Write', inputSchema: {type: 'object'}}], async invoke() {
            calls++;
            if (calls > 1) return {ok: true, output: {echo: 'replayed'}};
            if (failure === 'throw') throw new Error('Effects cannot be confirmed');
            return {
                ok: false,
                error: {code: 'tool_failed', message: 'Write may have committed', retryable: true, safeToReplay: false}
            };
        }
    };
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.status, 'failed');
    assert.equal(r.error.safeToReplay, false);
    assert.equal(r.error.retryable, false);
    assert.equal(r.error.code, failure === 'throw' ? 'outcome_unknown' : 'tool_failed');
    assert.equal(calls, 1);
    assert.equal(s.events.filter(e => e.type === 'terminal').length, 1);
    assert.deepEqual(s.events.filter(e => e.type === 'tool_finished').map(e => e.outcome), ['failed']);
});
test('a safely replayable tool error permits Codex to recover', async t => {
    const s = setup(t, 'tool-recovery');
    let calls = 0;
    s.host.tools = {
        definitions: [{name: 'read', description: 'Read', inputSchema: {type: 'object'}}], async invoke() {
            calls++;
            return calls === 1 ? {
                ok: false,
                error: {
                    code: 'tool_failed',
                    message: 'Temporary failure before work',
                    retryable: true,
                    safeToReplay: true
                }
            } : {ok: true, output: null};
        }
    };
    const r = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(r.status, 'completed');
    assert.equal(calls, 2);
});
for (const scenario of ['protocol-failure-active-tool', 'model-failure-active-tool']) test(`${scenario} closes the peer while retaining the session until host effects drain`, async t => {
    const s = setup(t, scenario);
    let releaseTool, aborted;
    const stopped = new Promise(resolve => {
        aborted = resolve;
    });
    const held = new Promise(resolve => {
        releaseTool = resolve;
    });
    s.host.tools = {
        definitions: [{name: 'write', description: 'Write', inputSchema: {type: 'object'}}], invoke(_call, signal) {
            signal.addEventListener('abort', aborted, {once: true});
            return held;
        }
    };
    const execution = await s.executor.start(s.request, s.host);
    let settled = false;
    void execution.result.then(() => {
        settled = true;
    });
    try {
        await stopped;
        const pid = Number(fs.readFileSync(path.join(s.dir, 'peer.pid'), 'utf8'));
        const alive = () => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                if (error.code === 'ESRCH') return false;
                throw error;
            }
        };
        for (let i = 0; i < 100 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(alive(), false, 'the failed model process must close before an uncooperative host tool finishes');
        assert.equal(settled, false);
        assert.ok(execution.session);
        assert.equal(s.events.filter(e => e.type === 'phase').at(-1)?.phase, 'cleanup');
        await assert.rejects(s.executor.start({...s.request, continuation: execution.session}, {
            ...s.host,
            attemptId: 'blocked'
        }), /active attempt/);
    } finally {
        releaseTool({ok: true, output: null});
        await execution.result;
    }
    const result = await execution.result;
    assert.equal(result.status, 'failed');
    assert.equal(result.error.safeToReplay, false);
    assert.equal(s.events.filter(e => e.type === 'terminal').length, 1);
    const next = await s.executor.start({...s.request, instruction: 'ok', continuation: execution.session}, {
        ...s.host,
        attemptId: 'after-drain'
    });
    assert.equal((await next.result).status, 'completed');
});

test('native Codex item events report actual tool activity once and reject foreign-turn activity', async t => {
    const s = setup(t, 'native-tools');
    const execution = await s.executor.start(s.request, s.host);
    assert.equal((await execution.result).status, 'completed');
    const started = s.events.filter(e => e.type === 'tool_started');
    const finished = s.events.filter(e => e.type === 'tool_finished');
    assert.deepEqual(started.map(e => e.tool), ['Codex command', 'Codex file change']);
    assert.deepEqual(finished.map(e => e.outcome), ['completed', 'failed']);
    assert.deepEqual(finished.map(e => e.callId), started.map(e => e.callId));
});

for (const [scenario, code, message] of [['failed', 'quota_exhausted', /usage limit/i], ['auth', 'authentication_failed', /authentication.*sign in/i]]) {
    test(`provider ${scenario} has a user-actionable message without automatic replay`, async t => {
        const s = setup(t, scenario);
        const result = await (await s.executor.start(s.request, s.host)).result;
        assert.equal(result.status, 'failed');
        assert.equal(result.error.code, code);
        assert.match(result.error.message, message);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.safeToReplay, false);
    });
}

// Use Node directly so a fresh fixture does not depend on executable cold starts.
function withProtocolPeer(s, config) {
    fs.writeFileSync(path.join(s.dir, 'codex-fixture.json'), JSON.stringify({...config, recordProtocol: true}));
    fs.writeFileSync(path.join(s.dir, 'app-server'), `require(${JSON.stringify(path.join(__dirname, 'fixtures/codex.cjs'))});\n`, {mode: 0o644});
    s.executor = new CodexTaskExecutor({cliPath: process.execPath, timeoutMs: 5000});
}

function protocolMessages(s) {
    return fs.readFileSync(path.join(s.dir, 'fixture-protocol.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

for (const userAgent of ['codex/0.159.0', 'codex/0.161.0', 'codex/1.0.0', 'custom-codex/dev']) {
    test(`accepts compatible protocol replies regardless of version metadata: ${userAgent}`, async t => {
        const s = setup(t);
        withProtocolPeer(s, {userAgent});
        const execution = await s.executor.start(s.request, s.host), result = await execution.result;
        assert.equal(result.status, 'completed', JSON.stringify(result));
        assert.equal(result.outputs.answer, 'ok');
        const messages = protocolMessages(s);
        const initializations = messages.filter(e => e.direction === 'received' && e.message.method === 'initialize');
        assert.equal(initializations.length, 1);
        const replies = messages.filter(e => e.direction === 'sent' && e.message.id === initializations[0].message.id);
        assert.equal(replies.length, 1);
        assert.equal(replies[0].message.result.userAgent, userAgent, 'the requested alternate version must actually reach the adapter');
    });
}
test('an unsupported protocol method fails explicitly without creating a thread or replaying', async t => {
    const s = setup(t);
    const initializeError = {code: -32601, message: 'method unavailable'};
    withProtocolPeer(s, {initializeError});
    const result = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /initialize.*-32601/);
    assert.equal(result.error.safeToReplay, false);
    const messages = protocolMessages(s);
    const requests = messages.filter(e => e.direction === 'received').map(e => e.message);
    assert.deepEqual(requests.map(m => m.method), ['initialize'], 'no thread/turn may start and initialization must not be retried');
    assert.deepEqual(messages.filter(e => e.direction === 'sent').map(e => e.message), [{id: requests[0].id, error: initializeError}]);
    assert.equal(s.events.some(e => e.type === 'phase' && e.phase === 'model'), false);
});

test('rejects pre-namespace session hashes even with the same custom executor ID before spawning', async t => {
    const options = {cliPath: path.join(__dirname, 'fixtures/codex.cjs'), timeoutMs: 5000, id: 'custom-coding'};
    const s = setup(t, 'ok', {}, options);
    const result = await (await s.executor.start(s.request, s.host)).result;
    assert.equal(result.status, 'completed');
    const saved = JSON.parse(result.session.opaqueId);
    saved.configHash = require('node:crypto').createHash('sha256').update(JSON.stringify(options)).digest('hex');
    const continuation = {...result.session, opaqueId: JSON.stringify(saved)};
    const before = s.events.length;
    await assert.rejects(s.executor.start({...s.request, continuation}, s.host), /configuration do not match/);
    assert.equal(s.events.length, before, 'must reject before an execution or model request');
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const {createCodeExecutor} = require('@openhilo/code-local');

function deferred() {
    let resolve;
    const promise = new Promise(done => {resolve = done;});
    return {promise, resolve};
}
const completed = () => ({status: 'completed', outputs: {}, artifacts: []});

function startScenario(t, {fallback, start, releaseSession, aiHost, onAiExecution}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cancellation-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'task.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({version: 2, entry: 'ai', nodes: {
        ai: {id: 'ai', type: 'call', executor: 'ai', intent: 'Offline task', inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'END',
            ...(fallback ? {on_failure: 'fallback'} : {})},
        ...(fallback ? {fallback: {id: 'fallback', type: 'call', executor: 'code', lang: 'python',
            script: "open('fallback-effect', 'w').write('executed')", inputsFrom: {}, outputsTo: {}, outputs: {}, next: 'END'}} : {}),
    }}));
    const events = [];
    let runDir, closed = false;
    const running = startRun({intent: 'task', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))),
        onRunCreated(_id, dir) {runDir = dir;}, onEvent: event => events.push(event),
        createResources: context => ({
            executor: createDispatcher({workdir: root, runId: context.runId, codeExecutor: createCodeExecutor(root), aiHost, onAiExecution,
                aiExecutor: {id: 'offline', capabilities: ['workspace', 'structured_output'], start, releaseSession}}),
            close() {closed = true;},
        }),
    });
    return {running, events, effect: () => fs.existsSync(path.join(root, 'fallback-effect')),
        get runDir() {return runDir;}, get closed() {return closed;}};
}

async function assertAborted(scenario) {
    assert.equal((await scenario.running).status, 'aborted');
    assert.equal(scenario.effect(), false);
    assert.equal(scenario.closed, true);
    assert.equal(fs.existsSync(path.join(scenario.runDir, 'run.lock')), false);
    assert.equal(scenario.events.at(-1).event, 'run_abort');
    assert.equal(scenario.events.some(event => ['run_failed', 'run_complete', 'suspended_state'].includes(event.event)), false);
    await assert.rejects(resumeRun({runDir: scenario.runDir,
        createResources() {throw new Error('Cancelled runs must not acquire executor resources');}}), /no suspended state/i);
}

for (const method of ['host signal', 'execution.cancel']) for (const fallback of [false, true]) {
    test(`${method}: cancellation aborts with failure branch ${fallback ? 'present' : 'absent'}`, {timeout: 5000}, async t => {
        const controller = new AbortController(), entered = deferred();
        let active;
        const scenario = startScenario(t, {fallback, aiHost: () => ({signal: controller.signal}),
            start(request, host) {
                active = createTaskExecution(request, host, async context => {
                    entered.resolve();
                    await new Promise(resolve => context.signal.addEventListener('abort', resolve, {once: true}));
                    return completed();
                });
                return active;
            }});
        await entered.promise;
        if (method === 'host signal') controller.abort('User requested stop');
        else await active.cancel('User requested stop');
        await assertAborted(scenario);
    });
}

for (const rejectRelease of [false, true]) {
    test(`cancelled result waits for session release and remains aborted when release ${rejectRelease ? 'rejects' : 'succeeds'}`, {timeout: 5000}, async t => {
        const entered = deferred(), release = deferred();
        const session = {executorId: 'offline', version: 1, opaqueId: 'session'};
        const scenario = startScenario(t, {fallback: true,
            start: async () => ({result: Promise.resolve({status: 'cancelled', reason: 'User requested stop', session})}),
            async releaseSession(actual) {
                assert.deepEqual(actual, session);
                entered.resolve();
                await release.promise;
                if (rejectRelease) throw new Error('Session cleanup failed');
            }});
        try {
            await entered.promise;
            assert.equal(scenario.closed, false);
            assert.equal(fs.existsSync(path.join(scenario.runDir, 'run.lock')), true);
            assert.equal(scenario.effect(), false);
            assert.equal(scenario.events.some(e => ['run_abort', 'run_failed', 'run_complete'].includes(e.event)), false);
        } finally {release.resolve();}
        await assertAborted(scenario);
    });
}

for (const mode of ['provider failure', 'timeout', 'unanswered question', 'handler attachment failure']) {
    for (const fallback of [false, true]) test(`${mode} still ${fallback ? 'routes to the failure branch' : 'saves a failed checkpoint'}`, {timeout: 5000}, async t => {
        const scenario = startScenario(t, {fallback,
            aiHost: mode === 'timeout' ? () => ({deadlineAt: new Date(Date.now() - 1).toISOString()}) : undefined,
            onAiExecution: mode === 'handler attachment failure' ? () => {throw new Error('Cannot attach');} : undefined,
            start: (request, host) => createTaskExecution(request, host, async context => {
                if (mode === 'unanswered question') await context.ask({id: 'q', prompt: 'Continue?', answer: 'text'});
                if (mode === 'handler attachment failure') await new Promise(resolve => context.signal.addEventListener('abort', resolve, {once: true}));
                return {status: 'failed', error: {code: 'executor_failed', message: 'Provider failure', retryable: false, safeToReplay: false}};
            })});
        assert.equal((await scenario.running).status, fallback ? 'completed' : 'failed');
        assert.equal(scenario.effect(), fallback);
        const failure = scenario.events.find(e => e.event === 'node_failed');
        assert.equal(failure.failure.code, mode === 'timeout' ? 'timeout' : mode === 'unanswered question' ? 'unsupported_capability' : 'executor_failed');
        if (!fallback) {
            assert.equal(scenario.events.at(-1).event, 'suspended_state');
            await assert.rejects(resumeRun({runDir: scenario.runDir, createResources() {throw new Error('Must not replay');}}), /unsafe/);
        }
    });
}

for (const rejectRelease of [false, true]) {
    test(`completed AI result retains ${rejectRelease ? 'failure routing on session-release error' : 'success after session release'}`, async t => {
        const session = {executorId: 'offline', version: 1, opaqueId: 'session'};
        const scenario = startScenario(t, {fallback: true,
            start: (request, host) => createTaskExecution(request, host, async () => ({...completed(), session})),
            async releaseSession() {if (rejectRelease) throw new Error('Session cleanup failed');}});
        assert.equal((await scenario.running).status, 'completed');
        assert.equal(scenario.effect(), rejectRelease);
        const failure = scenario.events.find(e => e.event === 'node_failed');
        if (rejectRelease) assert.equal(failure.failure.code, 'outcome_unknown');
        else assert.equal(failure, undefined);
    });
}

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {currentHumanTask} = require('@openhilo/runtime/human-tasks');
const {decodeCheckpointStack} = require('@openhilo/runtime');
const {FailableError} = require('@openhilo/runtime-contracts');

const human = (id, next) => ({id, type: 'call', executor: 'human', intent: 'Continue?', inputsFrom: {}, outputs: {ok: 'boolean'}, outputsTo: {ok: 'ok'}, next});
const code = (id, next) => ({id, type: 'call', executor: 'code', script: ':', inputsFrom: {}, outputs: {}, outputsTo: {}, next});
const failure = {code: 'executor_failed', message: 'boom', retryable: false, safeToReplay: true};

function fixture(t, nodes, entry, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-preflight-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const entryFile = path.join(dir, 'wf.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({version: 2, entry, nodes, ...extra}));
    return {
        intent: 'wf', entryFile, workdir: dir, runsDir: path.join(dir, 'runs'), inputs: {},
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, 'wf.itt.impl.json')),
    };
}

function records(runDir) {
    return {
        status: JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).status,
        log: fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8'),
        lock: fs.existsSync(path.join(runDir, 'run.lock')),
    };
}

function counting() {
    const counter = {resources: 0, effects: 0};
    counter.createResources = () => {
        counter.resources++;
        return {executor: async () => { counter.effects++; return {outputs: {}}; }};
    };
    return counter;
}

async function failedRun(t) {
    const result = await startRun({...fixture(t, {c: code('c', 'END')}, 'c'), createResources: () => ({
        executor: async () => { throw new FailableError(failure.message, failure); },
    })});
    assert.equal(result.status, 'failed');
    return result.runDir;
}

test('resume without the saved extension policies is rejected and keeps the Human checkpoint', async t => {
    const policy = {namespace: 'app', version: 1, derive: () => ({level: 1}), restore: ({state}) => state};
    const result = await startRun({
        ...fixture(t, {h: human('h', 'END')}, 'h', {requiredExtensions: [{namespace: 'app', version: 1}]}),
        extensions: [policy], createResources: () => ({executor: async () => ({outputs: {}})}),
    });
    assert.equal(result.status, 'suspended');
    const before = records(result.runDir);
    const counter = counting();
    for (const extensions of [undefined, [{...policy, version: 2}]]) {
        await assert.rejects(resumeRun({runDir: result.runDir, humanOutput: {ok: 'true'}, extensions, createResources: counter.createResources}),
            /Runtime extension error/);
    }
    assert.deepEqual(records(result.runDir), before);
    assert.equal(counter.resources, 0);
    assert.ok(currentHumanTask(result.runDir));
    const done = await resumeRun({runDir: result.runDir, humanOutput: {ok: 'true'}, extensions: [policy], createResources: counter.createResources});
    assert.equal(done.status, 'completed');
});

test('an edited snapshot missing the checkpoint node is rejected before resources and the run stays recoverable', async t => {
    const runDir = await failedRun(t);
    const snapshot = path.join(runDir, '.snapshot', 'wf.itt.impl.json');
    const original = fs.readFileSync(snapshot, 'utf8');
    fs.writeFileSync(snapshot, JSON.stringify({version: 2, entry: 'other', nodes: {other: code('other', 'END')}}));
    const before = records(runDir);
    const counter = counting();
    await assert.rejects(resumeRun({runDir, createResources: counter.createResources}), /Checkpoint node "c" is not in snapshot wf/);
    assert.deepEqual(records(runDir), before);
    assert.equal(counter.resources, 0);
    fs.writeFileSync(snapshot, original);
    assert.equal((await resumeRun({runDir, createResources: counter.createResources})).status, 'completed');
    assert.equal(counter.effects, 1);
});

test('malformed pending calls and return contexts fail before resources or status changes', async t => {
    for (const corrupt of [
        frames => { frames[0].pending_call = 'invalid'; },
        frames => { frames.push({...frames[0], frame_id: 'child', return_context: null}); },
        frames => { frames.length = 0; },
    ]) {
        const runDir = await failedRun(t);
        const file = path.join(runDir, 'execution.jsonl');
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
        const frames = decodeCheckpointStack(lines.at(-1).call_stack);
        corrupt(frames);
        lines.at(-1).call_stack = frames;
        fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
        const before = records(runDir);
        const counter = counting();
        await assert.rejects(resumeRun({runDir, createResources: counter.createResources}), /Invalid checkpoint/);
        assert.deepEqual(records(runDir), before);
        assert.equal(counter.resources, 0);
    }
});

test('a legacy Human answer is never silently dropped while a failed step is retried', async t => {
    const runDir = await failedRun(t);
    const before = records(runDir);
    const counter = counting();
    await assert.rejects(resumeRun({runDir, humanOutput: {ok: 'true'}, createResources: counter.createResources}), /not suspended at a human node/);
    assert.deepEqual(records(runDir), before);
    assert.equal(counter.resources, 0);
    assert.equal((await resumeRun({runDir, createResources: counter.createResources})).status, 'completed');
});

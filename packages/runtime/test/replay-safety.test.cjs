const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {Rehydrator} = require('@openhilo/runtime/rehydrator');
const {FailableError} = require('@openhilo/runtime-contracts');

const unsafe = {
    code: 'executor_failed',
    message: 'Connection lost after a tool effect',
    retryable: true,
    safeToReplay: false
};

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-safety-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'task.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({
        version: 2, entry: 'task', nodes: {
            task: {
                id: 'task',
                type: 'call',
                executor: 'ai',
                intent: 'Do work',
                inputsFrom: {},
                outputsTo: {},
                outputs: {},
                next: 'END'
            },
        }
    }));
    return {
        intent: 'task', entryFile, workdir: path.join(root, 'workspace'), runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot({snapshotDir}) {
            fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
        }
    };
}

function events(runDir) {
    return fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('structured executor failures retain replay safety in both durable failure events', async t => {
    const result = await startRun({
        ...fixture(t), createResources: () => ({
            executor: async () => {
                throw new FailableError(unsafe.message, unsafe);
            }
        })
    });
    assert.equal(result.status, 'failed');
    const failures = events(result.runDir).filter(event => ['node_failed', 'run_failed'].includes(event.event));
    assert.equal(failures.length, 2);
    for (const event of failures) assert.deepEqual(event.failure, unsafe);
});

test('unsafe failed runs reject resume before locks, metadata, resources or effects change', async t => {
    let attempts = 0, resources = 0;
    const createResources = () => {
        resources++;
        return {
            executor: async () => {
                attempts++;
                throw new FailableError(unsafe.message, unsafe);
            }
        };
    };
    const result = await startRun({...fixture(t), createResources});
    fs.rmSync(path.join(result.runDir, 'run.lock'), {force: true});
    const before = fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8');
    // Explicit fixture also proves preflight independently of failure event emission.
    const persisted = events(result.runDir).map(event => event.event === 'run_failed' ? {
        ...event,
        failure: unsafe
    } : event);
    fs.writeFileSync(path.join(result.runDir, 'execution.jsonl'), persisted.map(JSON.stringify).join('\n') + '\n');
    const persistedLog = fs.readFileSync(path.join(result.runDir, 'execution.jsonl'), 'utf8');
    await assert.rejects(resumeRun({runDir: result.runDir, createResources}), /unsafe|safe.*replay/i);
    assert.equal(new Rehydrator(result.runDir).rehydrate().kind, 'unsafe_to_replay');
    assert.equal(resources, 1);
    assert.equal(attempts, 1);
    assert.equal(fs.existsSync(path.join(result.runDir, 'run.lock')), false);
    assert.equal(fs.readFileSync(path.join(result.runDir, 'run.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(result.runDir, 'execution.jsonl'), 'utf8'), persistedLog);
});

for (const [name, failure] of [['legacy failure', undefined], ['safe non-retryable failure', {
    ...unsafe,
    retryable: false,
    safeToReplay: true
}]]) {
    test(`${name} permits an explicit resume`, async t => {
        let attempts = 0;
        const createResources = () => ({
            executor: async () => {
                if (++attempts === 1) throw new FailableError('Failed', failure);
                return {outputs: {}};
            }
        });
        const failed = await startRun({...fixture(t), createResources});
        fs.rmSync(path.join(failed.runDir, 'run.lock'), {force: true});
        assert.equal((await resumeRun({runDir: failed.runDir, createResources})).status, 'completed');
        assert.equal(attempts, 2);
    });
}

test('a handled unsafe failure does not prevent later human suspension recovery', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-history-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const log = [
        {event: 'run_failed', node_run_id: 'old', failure: unsafe},
        {event: 'run_resume'},
        {event: 'node_suspended', node_run_id: 'approval', reason: 'waiting_human'},
        {event: 'suspended_state', call_stack: [], global_seq: 3},
    ];
    fs.writeFileSync(path.join(root, 'execution.jsonl'), log.map(JSON.stringify).join('\n') + '\n');
    assert.equal(new Rehydrator(root).rehydrate().kind, 'suspended_no_output');
    assert.equal(new Rehydrator(root).rehydrate({approved: 'true'}).kind, 'ok');
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {currentHumanTask, submitHumanTask} = require('@openhilo/runtime/human-tasks');

async function suspended(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo recovery '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const entryFile = path.join(dir, 'approval.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({
        version: 2, entry: 'ask', nodes: {
            ask: {
                id: 'ask',
                type: 'call',
                executor: 'human',
                intent: 'Approve?',
                inputsFrom: {},
                outputsTo: {approved: 'approved'},
                outputs: {approved: 'boolean'},
                next: 'effect'
            },
            effect: {
                id: 'effect',
                type: 'call',
                executor: 'code',
                script: ':',
                inputsFrom: {},
                outputsTo: {},
                next: 'END'
            },
        }
    }));
    let effects = 0;
    const createResources = () => ({
        executor: async () => {
            effects++;
            return {outputs: {}};
        }
    });
    const run = await startRun({
        intent: 'approval', entryFile, workdir: dir, runsDir: path.join(dir, 'runs'), inputs: {}, createResources,
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)))
    });
    assert.equal(run.status, 'suspended');
    const task = currentHumanTask(run.runDir);
    return {
        ...run, createResources, effects: () => effects, task,
        submission: {taskId: task.taskId, submissionId: 'answer-1', outputs: {approved: 'true'}}
    };
}

for (const damage of ['missing', 'invalid-json', 'invalid-node']) test(`E7 ${damage} snapshot fails before downstream effects`, async t => {
    const f = await suspended(t), file = path.join(f.runDir, '.snapshot/approval.itt.impl.json');
    if (damage === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, damage === 'invalid-json' ? '{' : JSON.stringify({
        version: 2,
        entry: 'missing',
        nodes: {}
    }));
    await assert.rejects(resumeRun({
        runDir: f.runDir,
        humanSubmission: f.submission,
        createResources: f.createResources
    }));
    assert.equal(f.effects(), 0);
    assert.equal(fs.existsSync(path.join(f.runDir, 'run.lock')), false);
});
test('E4 invalid or missing Human fields preserve the pending task and journal', async t => {
    const f = await suspended(t), log = path.join(f.runDir, 'execution.jsonl'), before = fs.readFileSync(log);
    for (const outputs of [{}, {approved: 'yes'}, {approved: 'true', unknown: 'x'}]) {
        assert.equal(submitHumanTask(f.runDir, {...f.submission, outputs}).status, 'invalid');
        assert.deepEqual(fs.readFileSync(log), before);
        assert.equal(currentHumanTask(f.runDir).taskId, f.task.taskId);
    }
    assert.equal(f.effects(), 0);
});
test('E7 occupied run lock is not deleted or bypassed', async t => {
    const f = await suspended(t), lock = path.join(f.runDir, 'run.lock');
    fs.writeFileSync(lock, String(process.pid));
    const bytes = fs.readFileSync(lock);
    await assert.rejects(resumeRun({
        runDir: f.runDir,
        humanSubmission: f.submission,
        createResources: f.createResources
    }), /already running/);
    assert.deepEqual(fs.readFileSync(lock), bytes);
    assert.equal(f.effects(), 0);
});

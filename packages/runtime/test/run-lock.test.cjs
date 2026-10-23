const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fork, spawnSync} = require('node:child_process');
const {RunManager} = require('@openhilo/runtime/run-manager');
const {Rehydrator} = require('@openhilo/runtime/rehydrator');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {currentHumanTask, submitHumanTask, readHumanSubmission} = require('@openhilo/runtime/human-tasks');
const worker = path.join(__dirname, 'support/run-lock-worker.cjs');

function root(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lock-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
}

function managerFixture(t) {
    const dir = root(t);
    const manager = RunManager.create({runsDir: path.join(dir, 'runs'), intent: 'lock', workdir: dir});
    manager.update_status('suspended');
    manager.release();
    return manager;
}

async function suspended(t, secondHuman = false) {
    const dir = root(t), entryFile = path.join(dir, 'approval.itt.impl.json');
    const human = (id, next) => ({id, type: 'call', executor: 'human', intent: 'Continue?', inputsFrom: {}, outputs: {}, outputsTo: {}, next});
    fs.writeFileSync(entryFile, JSON.stringify({version: 2, entry: 'first', nodes: {
        first: human('first', 'effect'),
        effect: {id: 'effect', type: 'call', executor: 'code', script: ':', inputsFrom: {}, outputs: {}, outputsTo: {}, next: secondHuman ? 'second' : 'END'},
        ...(secondHuman ? {second: human('second', 'END')} : {}),
    }}));
    const result = await startRun({intent: 'approval', entryFile, workdir: dir, runsDir: path.join(dir, 'runs'), inputs: {}, humanMode: 'suspend',
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))),
        createResources: () => ({executor: async () => {throw new Error('Expected a Human suspension first');}})});
    assert.equal(result.status, 'suspended');
    const first = currentHumanTask(result.runDir);
    assert.equal(submitHumanTask(result.runDir, {taskId: first.taskId, submissionId: 'answer', outputs: {}}).status, 'accepted');
    return {dir, runDir: result.runDir, first};
}

function contender(t, f) {
    const child = fork(worker, ['compete', f.runDir, f.dir], {silent: true});
    t.after(() => {if (child.exitCode === null) child.kill();});
    let ready, outcome, stderr = '';
    const initialized = new Promise(resolve => {ready = resolve;});
    const observed = new Promise(resolve => {outcome = resolve;});
    child.stderr.on('data', data => {stderr += data;});
    child.on('message', message => {
        if (message.type === 'ready') ready();
        else if (['effect', 'rejected'].includes(message.type)) outcome(message);
    });
    const exited = new Promise(resolve => child.on('exit', code => {
        ready(); outcome({type: 'exited', code, stderr}); resolve({code, stderr});
    }));
    return {child, initialized, observed, exited};
}

for (const stale of [false, true]) test(`concurrent recovery executes one effect with ${stale ? 'a dead owner' : 'no lock'}`, {timeout: 15000}, async t => {
    const f = await suspended(t);
    if (stale) {
        const exited = spawnSync(process.execPath, ['-e', ''], {encoding: 'utf8'});
        assert.equal(exited.status, 0);
        fs.writeFileSync(path.join(f.runDir, 'run.lock'), String(exited.pid));
    }
    const contenders = [contender(t, f), contender(t, f)];
    await Promise.all(contenders.map(c => c.initialized));
    fs.writeFileSync(path.join(f.dir, 'go'), 'go');
    const outcomes = await Promise.all(contenders.map(c => c.observed));
    // The rejected worker closes its IPC channel immediately; only the owner
    // waits for this signal. Sending to the loser races its disconnect.
    for (const [index, c] of contenders.entries()) if (outcomes[index].type === 'effect') c.child.send('finish');
    const exits = await Promise.all(contenders.map(c => c.exited));
    assert.ok(exits.every(result => result.code === 0), JSON.stringify(exits));
    assert.equal(outcomes.filter(result => result.type === 'effect').length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter(result => result.type === 'rejected').length, 1, JSON.stringify(outcomes));
    assert.equal(fs.readFileSync(path.join(f.dir, 'effects.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.existsSync(path.join(f.runDir, 'run.lock')), false);
});

for (const pid of ['', 'not-a-pid', '0', '-1', '12garbage']) test(`invalid PID lock ${JSON.stringify(pid)} is preserved`, t => {
    const manager = managerFixture(t), lock = path.join(manager.runDir, 'run.lock');
    fs.writeFileSync(lock, pid);
    assert.throws(() => RunManager.resume(manager.runDir), /invalid.*lock/i);
    assert.equal(fs.readFileSync(lock, 'utf8'), pid);
});

test('an uninspectable PID is not treated as a dead owner', t => {
    const manager = managerFixture(t), lock = path.join(manager.runDir, 'run.lock');
    fs.writeFileSync(lock, '123456');
    const kill = process.kill;
    process.kill = (pid, signal) => {
        if (pid === 123456 && signal === 0) throw Object.assign(new Error('Operation not permitted'), {code: 'EPERM'});
        return kill(pid, signal);
    };
    try {assert.throws(() => RunManager.resume(manager.runDir), /already running/);}
    finally {process.kill = kill;}
    assert.equal(fs.readFileSync(lock, 'utf8'), '123456');
});

test('a released manager cannot release a later owner in the same process', t => {
    const previous = managerFixture(t);
    const current = RunManager.resume(previous.runDir);
    try {
        previous.release();
        assert.equal(fs.existsSync(path.join(current.runDir, 'run.lock')), true);
    } finally {current.release();}
});

test('an interrupted lock transition is preserved and reports inspection guidance', t => {
    const manager = managerFixture(t), guard = path.join(manager.runDir, 'run.lock.guard');
    fs.mkdirSync(guard);
    assert.throws(() => RunManager.resume(manager.runDir), /lock.*(busy|transition).*inspect/i);
    assert.equal(fs.existsSync(guard), true);
    assert.equal(fs.existsSync(path.join(manager.runDir, 'run.lock')), false);
});

for (const suppliedAnswer of [false, true]) test(`recovery revalidates the checkpoint with ${suppliedAnswer ? 'an answer for the old task' : 'no new answer'}`, async t => {
    const f = await suspended(t, true), resume = RunManager.resume;
    RunManager.resume = function(runDir) {
        const advanced = spawnSync(process.execPath, [worker, 'advance', runDir, f.dir], {encoding: 'utf8', timeout: 10000});
        assert.equal(advanced.status, 0, advanced.stderr);
        assert.equal(JSON.parse(advanced.stdout).status, 'suspended');
        return resume.call(this, runDir);
    };
    try {
        const pending = resumeRun({runDir: f.runDir, ...(suppliedAnswer ? {humanOutput: {}} : {}),
            createResources: () => ({executor: async () => {
                fs.appendFileSync(path.join(f.dir, 'effects.jsonl'), 'stale-replay\n');
                return {outputs: {}};
            }, humanExecutor: {id: 'defer', async present() {}}})});
        if (suppliedAnswer) await assert.rejects(pending, /no longer current/);
        else assert.equal((await pending).status, 'suspended');
        const current = currentHumanTask(f.runDir);
        assert.notEqual(current.taskId, f.first.taskId);
        assert.equal(readHumanSubmission(f.runDir, current.taskId), undefined);
        assert.equal(fs.readFileSync(path.join(f.dir, 'effects.jsonl'), 'utf8').trim().split('\n').length, 1);
    } finally {RunManager.resume = resume;}
});

test('an implicit answer is rejected when the task advances during preflight reads', async t => {
    const f = await suspended(t, true), rehydrate = Rehydrator.prototype.rehydrate;
    let advanced = false;
    Rehydrator.prototype.rehydrate = function(...args) {
        if (!advanced) {
            advanced = true;
            const result = spawnSync(process.execPath, [worker, 'advance', f.runDir, f.dir], {encoding: 'utf8', timeout: 10000});
            assert.equal(result.status, 0, result.stderr);
            assert.equal(JSON.parse(result.stdout).status, 'suspended');
        }
        return rehydrate.apply(this, args);
    };
    try {
        await assert.rejects(resumeRun({runDir: f.runDir, humanOutput: {},
            createResources: () => ({executor: async () => {throw new Error('Unexpected execution');}})}), /no longer current/);
        assert.equal(advanced, true);
        const current = currentHumanTask(f.runDir);
        assert.notEqual(current.taskId, f.first.taskId);
        assert.equal(readHumanSubmission(f.runDir, current.taskId), undefined);
        assert.equal(fs.readFileSync(path.join(f.dir, 'effects.jsonl'), 'utf8').trim().split('\n').length, 1);
        assert.equal(fs.existsSync(path.join(f.runDir, 'run.lock')), false);
    } finally {Rehydrator.prototype.rehydrate = rehydrate;}
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');

function fixture(t, extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-adapter-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'task.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({
        version: 2, entry: 'before', nodes: {
            before: {
                id: 'before',
                type: 'call',
                executor: 'code',
                script: ':',
                inputsFrom: {},
                outputsTo: {},
                next: 'approve'
            },
            approve: {
                id: 'approve',
                type: 'call',
                executor: 'human',
                intent: 'Approve?',
                inputsFrom: {},
                outputsTo: {},
                next: 'after', ...extra
            },
            after: {
                id: 'after',
                type: 'call',
                executor: 'code',
                script: ':',
                inputsFrom: {},
                outputsTo: {},
                next: 'END'
            },
        }
    }));
    const effects = [];
    return {
        effects, options: {
            intent: 'task',
            entryFile,
            workdir: root,
            runsDir: path.join(root, 'runs'),
            inputs: {},
            humanMode: 'suspend',
            populateSnapshot({snapshotDir}) {
                fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
            },
            createResources: () => ({
                executor: async node => {
                    effects.push(node.id);
                    return {outputs: {}};
                }
            }),
        }
    };
}

const logs = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('a human leaf sharing its current workflow name suspends instead of recursively delegating to itself', async t => {
    const f = fixture(t, {callee: 'task'});
    let frames = 0;
    const run = await startRun({
        ...f.options, onEvent(event) {
            if (event.event === 'frame_push' && ++frames > 2) throw new Error('Unexpected self delegation');
        }
    });
    assert.equal(run.status, 'suspended');
    assert.deepEqual(f.effects, ['before']);
    assert.equal(frames, 0);
    assert.equal(logs(run.runDir).filter(e => e.event === 'node_suspended').length, 1);
});

test('custom adapter receives a durable checkpoint before presentation and confirms a zero-field task', async t => {
    const f = fixture(t);
    let presented = false, runDir;
    const result = await startRun({
        ...f.options, onRunCreated(_id, dir) {
            runDir = dir;
        }, humanExecutor: {
            id: 'third-party', async present(request, host) {
                presented = true;
                assert.equal(logs(runDir).at(-1).event, 'suspended_state');
                assert.equal(request.prompt, 'Approve?');
                assert.deepEqual(request.outputs, {});
                const receipt = await host.submit({taskId: request.taskId, submissionId: 'choice-1', outputs: {}});
                assert.equal(receipt.status, 'accepted');
            },
        }
    });
    assert.equal(presented, true);
    assert.equal(result.status, 'completed');
    assert.deepEqual(f.effects, ['before', 'after']);
});

test('delivery failure preserves pending task; accepted submission survives restart and duplicate cannot replay', async t => {
    const f = fixture(t, {outputsTo: {approved: 'approved'}, outputs: {approved: 'boolean'}});
    const result = await startRun({
        ...f.options, humanExecutor: {
            id: 'broken-notifier', async present() {
                throw new Error('notification unavailable');
            }
        }
    });
    assert.equal(result.status, 'suspended');
    assert.ok(logs(result.runDir).some(e => e.event === 'human_delivery_failed'));
    const {currentHumanTask, submitHumanTask} = require('@openhilo/runtime/human-tasks');
    const request = currentHumanTask(result.runDir);
    const submission = {taskId: request.taskId, submissionId: 'receipt-1', outputs: {approved: 'true'}};
    assert.equal(submitHumanTask(result.runDir, {...submission, outputs: {approved: 'invalid'}}).status, 'invalid');
    assert.equal(submitHumanTask(result.runDir, submission).status, 'accepted');
    assert.equal(submitHumanTask(result.runDir, submission).status, 'duplicate');
    assert.equal(submitHumanTask(result.runDir, {...submission, outputs: {approved: 'false'}}).status, 'conflict');
    assert.equal(fs.existsSync(path.join(result.runDir, 'run.lock')), false);
    assert.equal((await resumeRun({
        runDir: result.runDir,
        createResources: f.options.createResources
    })).status, 'completed');
    assert.deepEqual(f.effects, ['before', 'after']);
    assert.equal(submitHumanTask(result.runDir, submission).status, 'duplicate');
    assert.equal(currentHumanTask(result.runDir), undefined);
    await assert.rejects(resumeRun({
        runDir: result.runDir,
        humanSubmission: submission,
        createResources: f.options.createResources
    }));
    assert.deepEqual(f.effects, ['before', 'after']);
});

test('obsolete decision payloads cannot submit or resume a human task', async t => {
    const f = fixture(t), run = await startRun(f.options);
    const {currentHumanTask, submitHumanTask} = require('@openhilo/runtime/human-tasks');
    const task = currentHumanTask(run.runDir);
    for (const decision of ['confirm', 'reject']) {
        const input = {taskId: task.taskId, submissionId: 'obsolete', decision, outputs: {}};
        assert.equal(submitHumanTask(run.runDir, input).status, 'invalid');
        await assert.rejects(resumeRun({
            runDir: run.runDir, humanSubmission: input, createResources() {
                throw new Error('RESOURCE_CREATED')
            }
        }), /exactly/);
        assert.equal(currentHumanTask(run.runDir).taskId, task.taskId);
        assert.deepEqual(f.effects, ['before']);
    }
});
test('invalid saved result fails before resource creation or continuation', async t => {
    const f = fixture(t, {outputsTo: {n: 'n'}, outputs: {n: 'number'}});
    const run = await startRun(f.options);
    const {currentHumanTask} = require('@openhilo/runtime/human-tasks');
    const request = currentHumanTask(run.runDir);
    fs.writeFileSync(path.join(run.runDir, 'human-tasks', request.taskId, 'submission.json'), JSON.stringify({
        taskId: request.taskId,
        submissionId: 'bad',
        outputs: {n: 'invalid'}
    }));
    await assert.rejects(resumeRun({
        runDir: run.runDir, createResources() {
            throw new Error('RESOURCE_CREATED');
        }
    }), /number/i);
    assert.deepEqual(f.effects, ['before']);
});

test('explicit adapter redelivery after restart retains task identity and does not replay prior work', async t => {
    const f = fixture(t);
    let original;
    const suspended = await startRun({
        ...f.options, humanExecutor: {
            id: 'deferred', async present(task) {
                original = task;
            }
        }
    });
    assert.equal(fs.existsSync(path.join(suspended.runDir, 'run.lock')), false);
    const result = await resumeRun({
        runDir: suspended.runDir, createResources: f.options.createResources, humanExecutor: {
            id: 'replacement', async present(task, host) {
                assert.equal(task.taskId, original.taskId);
                await host.submit({taskId: task.taskId, submissionId: 'redelivery', outputs: {}});
            },
        }
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(f.effects, ['before', 'after']);
});

test('concurrent processes accept exactly one immutable submission', async t => {
    const f = fixture(t), run = await startRun(f.options);
    const {currentHumanTask, readHumanSubmission} = require('@openhilo/runtime/human-tasks');
    const task = currentHumanTask(run.runDir);
    const {execFile} = require('node:child_process');
    const code = `const {submitHumanTask}=require('@openhilo/runtime/human-tasks'); process.stdout.write(JSON.stringify(submitHumanTask(process.argv[1],JSON.parse(process.argv[2]))));`;
    const receipts = await Promise.all(Array.from({length: 6}, (_, i) => new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', code, run.runDir, JSON.stringify({
                taskId: task.taskId,
                submissionId: `writer-${i}`,
                outputs: {}
            })],
            {cwd: path.resolve(__dirname, '../../..')}, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
    })));
    assert.equal(receipts.filter(r => r.status === 'accepted').length, 1);
    assert.equal(receipts.filter(r => r.status === 'conflict').length, 5);
    assert.equal(readHumanSubmission(run.runDir, task.taskId).submissionId, receipts.find(r => r.status === 'accepted').submissionId);
});

test('a stale accepted task cannot resume the next pending human operation', async t => {
    const f = fixture(t, {next: 'approve'});
    let first, visits = 0;
    const run = await startRun({
        ...f.options, humanExecutor: {
            id: 'once', async present(task, host) {
                if (++visits === 1) {
                    first = {taskId: task.taskId, submissionId: 'first', outputs: {}};
                    await host.submit(first);
                }
            }
        }
    });
    const {currentHumanTask} = require('@openhilo/runtime/human-tasks');
    const pending = currentHumanTask(run.runDir);
    assert.notEqual(pending.taskId, first.taskId);
    await assert.rejects(resumeRun({
        runDir: run.runDir,
        humanSubmission: first,
        createResources: f.options.createResources
    }), /no longer current/);
    assert.equal(currentHumanTask(run.runDir).taskId, pending.taskId);
    assert.deepEqual(f.effects, ['before']);
});

test('resource cleanup retains the lock until it settles, then same-process resumption works', async t => {
    const f = fixture(t);
    let release, ready, runDir;
    const entered = new Promise(resolve => {
        ready = resolve;
    });
    const pending = startRun({
        ...f.options, onRunCreated(_id, dir) {
            runDir = dir;
        }, createResources: () => ({
            executor: async () => ({outputs: {}}), close: () => new Promise(resolve => {
                release = resolve;
                ready();
            }),
        })
    });
    await entered;
    try {
        assert.equal(fs.existsSync(path.join(runDir, 'run.lock')), true);
        await assert.rejects(resumeRun({
            runDir,
            humanOutput: {},
            createResources: f.options.createResources
        }), /already running/);
        const {currentHumanTask, readHumanSubmission} = require('@openhilo/runtime/human-tasks');
        assert.equal(readHumanSubmission(runDir, currentHumanTask(runDir).taskId), undefined,
            'A rejected concurrent resume must not consume its Human answer');
    } finally {
        release();
    }
    await pending;
    assert.equal(fs.existsSync(path.join(runDir, 'run.lock')), false);
    assert.equal((await resumeRun({runDir, humanOutput: {}, createResources: f.options.createResources})).status, 'completed');
});

test('resuming an accepted task with an adapter does not confirm the following human task', async t => {
    const f = fixture(t, {next: 'approve'});
    const run = await startRun(f.options);
    const {currentHumanTask, submitHumanTask} = require('@openhilo/runtime/human-tasks');
    const original = currentHumanTask(run.runDir);
    submitHumanTask(run.runDir, {taskId: original.taskId, submissionId: 'first', outputs: {}});
    const displayed = [];
    const result = await resumeRun({
        runDir: run.runDir, createResources: f.options.createResources,
        humanExecutor: {
            id: 'second-inbox', async present(task) {
                displayed.push(task);
            }
        },
    });
    assert.equal(result.status, 'suspended');
    assert.equal(displayed.length, 1);
    assert.notEqual(displayed[0].taskId, original.taskId);
    assert.equal(currentHumanTask(run.runDir).taskId, displayed[0].taskId);
    assert.equal(logs(run.runDir).filter(e => e.event === 'human_submitted').length, 1);
    assert.deepEqual(f.effects, ['before']);
});

test('a resource-provided adapter can redisplay its pending operation on resume', async t => {
    const f = fixture(t);
    let calls = 0, taskId;
    const createResources = () => ({
        ...f.options.createResources(), humanExecutor: {
            id: 'resource-inbox', async present(task, host) {
                if (++calls === 1) {
                    taskId = task.taskId;
                    return;
                }
                assert.equal(task.taskId, taskId);
                await host.submit({taskId, submissionId: 'resource-answer', outputs: {}});
            }
        }
    });
    const run = await startRun({...f.options, createResources});
    assert.equal(run.status, 'suspended');
    assert.equal((await resumeRun({runDir: run.runDir, createResources})).status, 'completed');
    assert.equal(calls, 2);
    assert.deepEqual(f.effects, ['before', 'after']);
});

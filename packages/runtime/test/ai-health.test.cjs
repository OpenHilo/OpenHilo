const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createTaskExecution} = require('@openhilo/ai-contracts');

test('runtime persists and publishes stopping health while an uncooperative effect is still pending', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-health-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'task.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({
        version: 2, entry: 'task', nodes: {
            task: {
                id: 'task',
                type: 'call',
                executor: 'ai',
                intent: 'Work',
                inputsFrom: {},
                outputsTo: {},
                outputs: {},
                next: 'END'
            },
        }
    }));
    let finish, active, runDir, closed = false;
    let ready;
    const entered = new Promise(resolve => {
        ready = resolve;
    });
    let stalled;
    const observed = new Promise(resolve => {
        stalled = resolve;
    });
    const events = [];
    const run = startRun({
        intent: 'task', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot({snapshotDir}) {
            fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
        },
        onRunCreated(_id, dir) {
            runDir = dir;
        },
        onEvent(event) {
            events.push(event);
            if (event.event === 'ai_health' && event.health.phase === 'stopping' && event.health.condition === 'stalled') stalled();
        },
        createResources(context) {
            return {
                executor: createDispatcher({
                    workdir: context.workdir, runId: context.runId,
                    aiHost: () => ({
                        monitoring: {
                            heartbeatMs: 5,
                            slowAfterMs: 10,
                            stalledAfterMs: 20,
                            stopGraceMs: 10
                        }
                    }),
                    aiExecutor: {
                        id: 'offline', capabilities: ['workspace', 'structured_output'], async start(request, host) {
                            active = createTaskExecution(request, host, async ctx => {
                                ctx.emit({type: 'tool_started', callId: 'c', tool: 'write'});
                                ready();
                                await new Promise(resolve => {
                                    finish = resolve;
                                });
                                return {status: 'completed', outputs: {}, artifacts: []};
                            });
                            return active;
                        }
                    },
                }), close() {
                    closed = true;
                },
            };
        },
    });
    await entered;
    const cancellation = active.cancel('stop');
    try {
        await observed;
        assert.equal(closed, false);
        assert.equal(active.state, 'stopping');
        assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'running');
        const log = fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        const event = log.findLast(e => e.event === 'ai_health');
        assert.equal(event.health.condition, 'stalled');
        assert.equal(event.health.activeTools, 1);
        assert.ok(event.node_run_id && event.attempt_id && event.task_id);
        assert.deepEqual(event, events.findLast(e => e.event === 'ai_health'));
    } finally {
        finish();
        await cancellation;
    }
    const result = await run;
    assert.equal(result.status, 'aborted');
    assert.equal(closed, true);
    assert.equal(fs.existsSync(path.join(runDir, 'run.lock')), false);
    await assert.rejects(resumeRun({
        runDir, createResources() {
            throw new Error('MUST NOT ACQUIRE');
        }
    }), /no suspended state/i);
});


test('a synchronous executor failure closes telemetry before writing the resumable state', async t => {
    const {FailableError} = require('@openhilo/runtime-contracts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-health-late-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'task.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({
        version: 2, entry: 'task', nodes: {
            task: {
                id: 'task',
                type: 'call',
                executor: 'ai',
                intent: 'Work',
                inputsFrom: {},
                outputsTo: {},
                outputs: {},
                next: 'END'
            },
        }
    }));
    let context;
    const failed = await startRun({
        intent: 'task', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot({snapshotDir}) {
            fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
        },
        createResources: () => ({
            executor(_node, _inputs, ctx) {
                context = ctx;
                throw new FailableError('startup failure');
            }
        }),
    });
    const logFile = path.join(failed.runDir, 'execution.jsonl');
    const saved = fs.readFileSync(logFile, 'utf8');
    context.onAiEvent({
        type: 'health',
        taskId: 'late',
        attemptId: 'late',
        sequence: 99,
        timestamp: new Date().toISOString(),
        health: {phase: 'stopping'}
    });
    assert.equal(fs.readFileSync(logFile, 'utf8'), saved);
});

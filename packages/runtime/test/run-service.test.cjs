const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');

function setup(t, workflow) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-run-service-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'report.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify(workflow));
    return {
        root, options: {
            intent: 'namespace/report',
            entryFile,
            workdir: path.join(root, 'workspace'),
            runsDir: path.join(root, 'runs'),
            inputs: {},
            populateSnapshot({snapshotDir}) {
                fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
            }
        }
    };
}

const call = (id, next) => ({
    id,
    type: 'call',
    executor: 'code',
    script: ':',
    inputsFrom: {},
    outputsTo: {},
    outputs: {},
    next
});
const simple = {version: 2, entry: 'work', nodes: {work: call('work', 'END')}};

test('AI, code and system leaves are not replaced by their enclosing workflow', async t => {
    for (const executor of ['ai', 'code', 'sys']) {
        const f = setup(t, {
            version: 2, entry: 'work', nodes: {
                work: {...call('work', 'END'), executor, callee: 'report'},
            }
        });
        let leafCalls = 0, frames = 0;
        const result = await startRun({
            ...f.options,
            onEvent(event) {
                if (event.event === 'frame_push' && ++frames > 2) throw new Error('Same-name leaf was incorrectly expanded recursively');
            },
            createResources: () => ({
                executor: async node => {
                    assert.equal(node.executor, executor);
                    leafCalls++;
                    return {outputs: {}};
                }
            }),
        });
        assert.equal(result.status, 'completed');
        assert.equal(leafCalls, 1);
    }
});

test('AI and human calls retain existing implementation-workflow delegation', async t => {
    for (const executor of ['ai', 'human']) {
        const f = setup(t, {
            version: 2, entry: 'work', nodes: {
                work: {
                    ...call('work', 'END'),
                    executor,
                    callee: 'child',
                    outputs: {value: 'number'},
                    outputsTo: {value: 'answer'}
                },
            }, outputs: {answer: 'answer'}
        });
        const child = {
            version: 2, entry: 'value', nodes: {
                value: {
                    id: 'value',
                    type: 'assign',
                    assignments: [{var: 'value', type: 'number', expr: '42'}],
                    next: 'END'
                },
            }, outputs: {value: 'value'}
        };
        const events = [];
        const result = await startRun({
            ...f.options,
            populateSnapshot(context) {
                f.options.populateSnapshot(context);
                fs.writeFileSync(path.join(context.snapshotDir, 'child.itt.impl.json'), JSON.stringify(child));
            },
            onEvent: event => events.push(event),
            createResources: () => ({
                executor: async () => {
                    throw new Error('Implementation should handle this call');
                }
            }),
        });
        assert.equal(result.status, 'completed');
        assert.equal(events.find(event => event.event === 'run_complete').outputs.answer, 42);
    }
});

test('tagged AI leaves dispatch even when another implementation shares the name', async t => {
    const f = setup(t, {version: 2, entry: 'work', nodes: {
        work: {...call('work', 'END'), executor: 'ai', callee: 'child',
            aiSelection: {type: 'coding'}, outputs: {value: 'number'}, outputsTo: {value: 'answer'}},
    }, outputs: {answer: 'answer'}});
    const events = [];
    let calls = 0;
    const result = await startRun({...f.options,
        populateSnapshot(context) {
            f.options.populateSnapshot(context);
            fs.writeFileSync(path.join(context.snapshotDir, 'child.itt.impl.json'), JSON.stringify({
                version: 2, entry: 'wrong', nodes: {wrong: {id: 'wrong', type: 'assign',
                    assignments: [{var: 'value', type: 'number', expr: '-1'}], next: 'END'}}, outputs: {value: 'value'},
            }));
        },
        onEvent: event => events.push(event),
        createResources: () => ({executor: async node => {
            calls++;
            assert.deepEqual(node.aiSelection, {type: 'coding'});
            return {outputs: {value: 42}};
        }}),
    });
    assert.equal(result.status, 'completed');
    assert.equal(calls, 1);
    assert.equal(events.find(event => event.event === 'run_complete').outputs.answer, 42);
    assert.equal(events.some(event => event.event === 'frame_push' && event.callee === 'child'), false);
});

test('missing child implementation records an actionable abort reason', async t => {
    const f = setup(t, {
        version: 2, entry: 'child', nodes: {
            child: {
                id: 'child',
                type: 'call',
                executor: 'intent',
                callee: 'team.missing',
                inputsFrom: {},
                outputsTo: {},
                next: 'END'
            },
        }
    });
    const events = [];
    const result = await startRun({
        ...f.options, onEvent: event => events.push(event),
        createResources: () => ({
            executor: async () => {
                throw new Error('Unexpected external call');
            }
        }),
    });
    assert.equal(result.status, 'aborted');
    assert.match(events.find(event => event.event === 'run_abort')?.reason ?? '', /requires impl ITT.*team\.missing/);
    assert.ok(events.some(event => event.event === 'node_failed'));
});

test('standalone start and resume preserve snapshot entry, human state, metadata and resource cleanup', async t => {
    const f = setup(t, {
        version: 2, entry: 'before', nodes: {
            before: call('before', 'approve'),
            approve: {
                id: 'approve',
                type: 'call',
                executor: 'human',
                intent: 'Approve?',
                inputsFrom: {},
                outputsTo: {approved: 'approved'},
                outputs: {approved: 'boolean'},
                next: 'after'
            },
            after: {...call('after', 'END'), inputsFrom: {approved: '$approved'}},
        }
    });
    const effects = [], contexts = [];
    let closed = 0;
    const createResources = context => {
        contexts.push(context);
        return {
            executor: async (node, inputs) => {
                effects.push([node.id, inputs]);
                return {outputs: {}};
            }, close() {
                closed++;
            }
        };
    };
    const suspended = await startRun({
        ...f.options,
        humanMode: 'suspend',
        receipt: {selected_application: 'custom', selected_executor: 'offline'},
        createResources
    });
    assert.equal(suspended.status, 'suspended');
    assert.equal(closed, 1);
    assert.deepEqual(effects, [['before', {}]]);
    const record = JSON.parse(fs.readFileSync(path.join(suspended.runDir, 'run.json')));
    assert.equal(record.entry_intent, 'report');
    assert.equal(record.selected_executor, 'offline');
    await assert.rejects(resumeRun({runDir: suspended.runDir, createResources}), /provide --human-output/);
    assert.equal(contexts.length, 2);
    // The run service releases its lock only after resource cleanup.
    assert.equal(fs.existsSync(path.join(suspended.runDir, 'run.lock')), false);
    const completed = await resumeRun({runDir: suspended.runDir, humanOutput: {approved: 'true'}, createResources});
    assert.equal(completed.status, 'completed');
    assert.equal(closed, 3);
    assert.deepEqual(effects, [['before', {}], ['after', {approved: true}]]);
    assert.equal(contexts[1].entryIntent, 'report');
    assert.equal(contexts[1].workdir, f.options.workdir);
    assert.equal(JSON.parse(fs.readFileSync(path.join(completed.runDir, 'run.json'))).selected_application, 'custom');
});

test('snapshot validation failure aborts the run before constructing executor resources', async t => {
    const f = setup(t, {version: 2, entry: 'missing', nodes: {}});
    let runDir, created = 0;
    const events = [];
    await assert.rejects(startRun({
        ...f.options, onEvent: event => events.push(event), onRunCreated(_id, dir) {
            runDir = dir;
        }, createResources() {
            created++;
            throw new Error('Unreachable');
        }
    }), /Validation errors/);
    assert.equal(created, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'aborted');
    assert.match(events.find(event => event.event === 'run_abort')?.reason ?? '', /Validation errors/);
    assert.deepEqual(fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), events);
});

test('resuming a human answer reports running before downstream effects and suspends again at the next question', async t => {
    const human = (id, next) => ({
        id, type: 'call', executor: 'human', intent: 'Continue?',
        inputsFrom: {}, outputsTo: {approved: 'approved'}, outputs: {approved: 'boolean'}, next
    });
    const f = setup(t, {
        version: 2, entry: 'first', nodes: {
            first: human('first', 'effect'), effect: call('effect', 'second'), second: human('second', 'END'),
        }
    });
    const observed = [];
    const createResources = context => ({
        executor: async () => {
            observed.push(JSON.parse(fs.readFileSync(path.join(context.runDir, 'run.json'))).status);
            return {outputs: {}};
        }
    });
    const started = await startRun({...f.options, humanMode: 'suspend', createResources});
    assert.equal(started.status, 'suspended');
    const resumedStatuses = [];
    const resumed = await resumeRun({
        runDir: started.runDir, humanOutput: {approved: 'false'}, createResources,
        onEvent(event) {
            if (event.event === 'run_resume') resumedStatuses.push(JSON.parse(fs.readFileSync(path.join(started.runDir, 'run.json'))).status);
        },
    });
    assert.deepEqual(observed, ['running']);
    assert.deepEqual(resumedStatuses, ['running']);
    assert.equal(resumed.status, 'suspended');
    assert.equal(JSON.parse(fs.readFileSync(path.join(started.runDir, 'run.json'))).status, 'suspended');
});

test('input contract drift records its reason before executor resources are created', async t => {
    const f = setup(t, {...simple, inputs: {requiredNew: {kind: 'text'}}});
    let runDir, created = 0;
    await assert.rejects(startRun({
        ...f.options, inputEncoding: 'typed-text-v1', onRunCreated(_id, dir) {
            runDir = dir;
        }, createResources() {
            created++;
            throw new Error('Unreachable');
        }
    }), /requiredNew/);
    assert.equal(created, 0);
    const events = fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.match(events.find(event => event.event === 'run_abort')?.reason ?? '', /requiredNew/);
    assert.equal(fs.existsSync(path.join(runDir, 'run.lock')), false);
});

test('unexpected execution failure closes resources and is recorded without replay', async t => {
    const f = setup(t, simple);
    let runDir, effects = 0, closed = 0;
    await assert.rejects(startRun({
        ...f.options, onRunCreated(_id, dir) {
            runDir = dir;
        }, createResources: () => ({
            executor: async () => {
                effects++;
                throw new Error('Unexpected effect failure');
            }, close() {
                closed++;
            },
        })
    }), /Unexpected effect failure/);
    assert.equal(effects, 1);
    assert.equal(closed, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'failed');
});

test('receipt cannot replace runtime-owned identity or carry live objects', async t => {
    const f = setup(t, simple);
    const base = {
        ...f.options, createResources: () => {
            throw new Error('Unreachable');
        }
    };
    await assert.rejects(startRun({...base, receipt: {status: 'completed'}}), /runtime-owned keys/);
    await assert.rejects(startRun({
        ...base, receipt: {
            live: () => {
            }
        }
    }), /JSON metadata/);
    assert.equal(fs.existsSync(f.options.runsDir), false);
});

test('resource construction failure records failure rather than leaving a running receipt', async t => {
    const f = setup(t, simple);
    let runDir;
    await assert.rejects(startRun({
        ...f.options, onRunCreated(_id, dir) {
            runDir = dir;
        }, createResources() {
            throw new Error('Host unavailable');
        }
    }), /Host unavailable/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'failed');
});

test('run-service loads with all application, platform, database and AI implementations forbidden', () => {
    require('node:child_process').execFileSync(process.execPath, ['-e', `
    const Module = require('node:module'), original = Module._load;
    Module._load = function(id, ...args) {
      if (/platform-services|solo-company|ai-sdk|ai-claude-code|better-sqlite3|openai|anthropic/.test(id)) throw new Error('Forbidden dependency: ' + id);
      return original.call(this, id, ...args);
    };
    require('@openhilo/runtime/run-service');
  `], {stdio: 'pipe'});
});

test('run creation acknowledgment completes before snapshot or executor effects, and live events reach the host', async t => {
    const f = setup(t, simple), order = [], events = [];
    const result = await startRun({
        ...f.options,
        async onRunCreated() {
            order.push('created');
            await new Promise(resolve => setTimeout(resolve, 5));
            order.push('acknowledged');
        },
        populateSnapshot(context) {
            order.push('snapshot');
            f.options.populateSnapshot(context);
        },
        createResources: () => ({
            executor: async () => {
                order.push('effect');
                return {outputs: {}};
            }
        }),
        onEvent: event => events.push(event),
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(order, ['created', 'acknowledged', 'snapshot', 'effect']);
    assert.ok(events.some(event => event.event === 'node_success'));
    assert.deepEqual(events.map(event => event.event), fs.readFileSync(path.join(result.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).event));
});

test('failed creation acknowledgment aborts before snapshots or workflow effects', async t => {
    const f = setup(t, simple);
    let runDir;
    await assert.rejects(startRun({
        ...f.options,
        async onRunCreated(_id, dir) {
            runDir = dir;
            throw new Error('Parent disconnected');
        },
        populateSnapshot() {
            throw new Error('Unexpected snapshot');
        },
        createResources() {
            throw new Error('Unexpected resources');
        },
    }), /Parent disconnected/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'aborted');
    assert.deepEqual(fs.readdirSync(path.join(runDir, '.snapshot')), []);
});

test('resource close errors still release the run lock', async t => {
    const f = setup(t, simple);
    let runDir;
    await assert.rejects(startRun({
        ...f.options, onRunCreated(_id, dir) {
            runDir = dir;
        }, createResources: () => ({
            executor: async () => ({outputs: {}}), close() {
                throw new Error('Close failed');
            }
        })
    }), /Close failed/);
    assert.equal(fs.existsSync(path.join(runDir, 'run.lock')), false);
});

test('nested input validation uses the saved workflow before any executor resources are created', async t => {
    const shape = {type:'object',properties:{budget:{shape:{type:'number'}},skills:{shape:{type:'array',items:{type:'text'}}}}};
    const f = setup(t, {...simple, inputs:{context:{kind:'json',shape}}});
    let resources = 0;
    for (const value of [{budget:'10',skills:[]},{budget:0,skills:[false]},{}]) {
        await assert.rejects(startRun({...f.options,inputEncoding:'typed-text-v1',inputs:{context:JSON.stringify(value)},createResources:()=>{resources++;throw new Error('must not execute');}}), /context\.(budget|skills)/);
    }
    assert.equal(resources,0);
    const result = await startRun({...f.options,inputEncoding:'typed-text-v1',inputs:{context:JSON.stringify({budget:0,skills:[]})},createResources:()=>({executor:async()=>({outputs:{}})})});
    assert.equal(result.status,'completed');
});

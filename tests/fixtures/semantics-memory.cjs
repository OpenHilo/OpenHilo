// Isolated process, explicit GC only for measuring reachability (never production behavior).
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'),
    path = require('node:path');
const {startRun} = require('@openhilo/runtime/run-service');
const {ScopeManager} = require('@openhilo/runtime');
const {FailableError, AbortError} = require('@openhilo/runtime-contracts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-memory-'));
const refs = [];
// Do not dereference targets in an async probe frame: V8 may keep its temporary
// registers alive across await even after the source expression is finished.
// Only a boolean crosses back into the waiting human callback. This keeps the
// observer from becoming a strong owner of the object it measures.
function isAlive(ref) {
    return ref.deref() !== undefined;
}
const push = ScopeManager.prototype.push;
ScopeManager.prototype.push = function (scope) {
    refs.push(new WeakRef(this));
    return push.call(this, scope);
};
const settle = async () => {
    for (let i = 0; i < 4; i++) {
        await new Promise(r => setImmediate(r));
        // Measure workflow reachability after full V8 collection, outside the JS stack.
        // Regular major GC can retain objects through engine compilation caches;
        // last-resort clears those caches (as heap snapshots do). Strong application
        // references still survive: the retained-loop negative control must fail.
        // See Node's deps/v8/src/extensions/gc-extension.cc and Heap::CollectAllAvailableGarbage.
        // Keep four collections; never retry based on whether a WeakRef disappears.
        await global.gc({type: 'major', execution: 'async', flavor: 'last-resort'});
    }
};
let opened = 0, closed = 0;

async function batch() {
    for (const state of ['completed', 'suspended', 'failed', 'aborted']) {
        const entryFile = path.join(root, state + '.itt.impl.json');
        const cfg = {
            version: 2, entry: 'init', nodes: {
                init: {
                    id: 'init',
                    type: 'assign',
                    assignments: [{
                        var: 'data',
                        type: 'json',
                        expr: 'Array.from({length:20000},(_,n)=>n)'
                    }, {var: 'alias', type: 'json', expr: 'data'}, {
                        var: 'nested',
                        type: 'json',
                        expr: '({data,again:data})'
                    }],
                    next: 'step'
                },
                step: {
                    id: 'step',
                    type: 'call',
                    executor: state === 'suspended' ? 'human' : 'ai',
                    intent: 'Check',
                    inputsFrom: {},
                    outputsTo: {},
                    outputs: {},
                    next: 'END'
                },
            }
        };
        fs.writeFileSync(entryFile, JSON.stringify(cfg));
        const result = await startRun({
            intent: state, entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
            populateSnapshot({snapshotDir}) {
                fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
            },
            createResources() {
                opened++;
                return {
                    executor: async () => {
                        if (state === 'failed') throw new FailableError('Fixture failure');
                        if (state === 'aborted') throw new AbortError('Fixture abort');
                        return {outputs: {}};
                    }, close() {
                        closed++;
                    }
                };
            }
        });
        assert.equal(result.status, state);
        fs.rmSync(result.runDir, {recursive: true, force: true});
    }
}

(async () => {
    try {
        for (let i = 0; i < 3; i++) await batch();
        await settle();
        const baseline = process.memoryUsage().heapUsed;
        const samples = [];
        for (let phase = 0; phase < 3; phase++) {
            for (let i = 0; i < 6; i++) await batch();
            await settle();
            samples.push(process.memoryUsage().heapUsed);
            assert.equal(refs.filter(isAlive).length, 0, 'completed/suspended/failed/aborted run scopes must be collectible');
        }
        assert.equal(closed, opened);
        // Bound retained heap, not RSS (V8 may keep freed pages). A leaked 20k array/run exceeds this margin.
        assert.ok(samples.at(-1) - baseline < 8 * 1024 * 1024, JSON.stringify({baseline, samples}));
        // Once restored, the raw checkpoint must not pin values cleared by later nodes.
        const entryFile = path.join(root, 'resume-memory.itt.impl.json');
        const cfg = {
            version: 2, entry: 'init', nodes: {
                init: {
                    id: 'init',
                    type: 'assign',
                    assignments: [{
                        var: 'data',
                        type: 'json',
                        expr: 'Array.from({length:20000},(_,n)=>n)'
                    }, {var: 'alias', type: 'json', expr: 'data'}, {
                        var: 'nested',
                        type: 'json',
                        expr: '({data,again:data})'
                    }],
                    next: 'first'
                },
                first: {
                    id: 'first',
                    type: 'call',
                    executor: 'human',
                    intent: 'First',
                    inputsFrom: {},
                    outputsTo: {},
                    outputs: {},
                    next: 'clear'
                },
                clear: {
                    id: 'clear',
                    type: 'assign',
                    assignments: [{var: 'data', type: 'json', expr: 'null'}, {
                        var: 'alias',
                        type: 'json',
                        expr: 'null'
                    }, {var: 'nested', type: 'json', expr: 'null'}],
                    next: 'second'
                },
                second: {
                    id: 'second',
                    type: 'call',
                    executor: 'human',
                    intent: 'Second',
                    inputsFrom: {},
                    outputsTo: {},
                    outputs: {},
                    next: 'END'
                },
            }
        };
        fs.writeFileSync(entryFile, JSON.stringify(cfg));
        const createResources = () => ({
            executor: async () => {
                throw Error('Unexpected effect');
            }
        });
        const first = await startRun({
            intent: 'resume-memory',
            entryFile,
            workdir: root,
            runsDir: path.join(root, 'runs'),
            inputs: {},
            createResources,
            populateSnapshot({snapshotDir}) {
                fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
            }
        });
        const checkpointRefs = [];
        const deserialize = ScopeManager.prototype.deserialize;
        ScopeManager.prototype.deserialize = function (snapshot) {
            for (const scope of snapshot) if (Array.isArray(scope.vars.data)) checkpointRefs.push(new WeakRef(scope.vars.data));
            return deserialize.call(this, snapshot);
        };
        let checked = false;
        try {
            const next = await require('@openhilo/runtime/run-service').resumeRun({
                runDir: first.runDir, humanOutput: {}, createResources, humanExecutor: {
                    id: 'memory-probe', async present() {
                        await settle();
                        checked = checkpointRefs.every(ref => ref.deref() === undefined);
                    }
                }
            });
            assert.equal(next.status, 'suspended');
            assert.ok(checkpointRefs.length);
            assert.ok(checked, 'raw recovery checkpoint retains cleared data during subsequent human wait');
        } finally {
            ScopeManager.prototype.deserialize = deserialize;
        }

        // The loop target is a root even after the source binding and item are cleared.
        // Observe the actual engine scopes, not a copied event/checkpoint payload.
        const loopFile = path.join(root, 'loop-memory.itt.impl.json');
        fs.writeFileSync(loopFile, JSON.stringify({
            version: 2, entry: 'init', nodes: {
                init: {
                    id: 'init',
                    type: 'assign',
                    assignments: [{
                        var: 'items',
                        type: 'json',
                        expr: '[{payload:Array.from({length:20000},(_,n)=>n)}]'
                    }],
                    next: 'loop'
                },
                loop: {
                    id: 'loop',
                    type: 'foreach',
                    array_expr: 'items',
                    item_var: 'item',
                    next_body: 'drop',
                    next_exit: 'after'
                },
                drop: {
                    id: 'drop',
                    type: 'assign',
                    assignments: [{var: 'items', type: 'json', expr: 'null'}, {
                        var: 'item',
                        type: 'json',
                        expr: 'null'
                    }],
                    next: 'inside'
                },
                inside: {
                    id: 'inside',
                    type: 'call',
                    executor: 'human',
                    intent: 'InsideLoop',
                    inputsFrom: {},
                    outputsTo: {},
                    outputs: {},
                    next: 'loop'
                },
                after: {
                    id: 'after',
                    type: 'call',
                    executor: 'human',
                    intent: 'AfterLoop',
                    inputsFrom: {},
                    outputsTo: {},
                    outputs: {},
                    next: 'END'
                },
            }
        }));
        // Fault injection retains the actual popped scope, not a copied snapshot.
        // This proves full collection cannot hide a real workflow reference leak.
        const retainedLoopContexts = [];
        const promote = ScopeManager.prototype.promote_and_pop_until_including;
        if (process.argv.includes('--retain-exited-loop')) {
            ScopeManager.prototype.promote_and_pop_until_including = function (context) {
                retainedLoopContexts.push(context);
                return promote.call(this, context);
            };
        }
        const loopTargets = [];
        const deliveryErrors = [];
        const trackedPush = ScopeManager.prototype.push;
        ScopeManager.prototype.push = function (scope) {
            if (scope.kind === 'loop-context' && scope.array) loopTargets.push(new WeakRef(scope.array[0]));
            return trackedPush.call(this, scope);
        };
        let loopTargetRetainedWhileActive = false, loopTargetReleasedAfterExit = false;
        try {
            const result = await startRun({
                intent: 'loop-memory',
                onEvent(event) {
                    if (event.event === 'human_delivery_failed') deliveryErrors.push(event.error);
                },
                entryFile: loopFile,
                workdir: root,
                runsDir: path.join(root, 'runs'),
                inputs: {},
                createResources,
                populateSnapshot({snapshotDir}) {
                    fs.copyFileSync(loopFile, path.join(snapshotDir, path.basename(loopFile)));
                },
                humanExecutor: {
                    id: 'loop-memory-probe', async present(task, ctx) {
                        await settle();
                        assert.equal(loopTargets.length, 1);
                        if (task.prompt === 'InsideLoop') {
                            loopTargetRetainedWhileActive = isAlive(loopTargets[0]);
                            assert.ok(loopTargetRetainedWhileActive, 'active iterator must retain its original array element');
                            assert.equal((await ctx.submit({
                                taskId: task.taskId,
                                submissionId: 'advance',
                                outputs: {}
                            })).status, 'accepted');
                        } else {
                            assert.equal(task.prompt, 'AfterLoop');
                            loopTargetReleasedAfterExit = !isAlive(loopTargets[0]);
                            assert.ok(loopTargetReleasedAfterExit, 'exited iterator must not pin its cleared target during the next human wait');
                        }
                    }
                }
            });
            assert.equal(result.status, 'suspended');
            assert.deepEqual(deliveryErrors, [], 'memory probe assertions must not be hidden by human-delivery error handling');
            assert.ok(loopTargetReleasedAfterExit);
        } finally {
            ScopeManager.prototype.push = trackedPush;
            ScopeManager.prototype.promote_and_pop_until_including = promote;
            retainedLoopContexts.length = 0;
        }
        await settle();
        assert.equal(refs.filter(isAlive).length, 0);
        console.log(JSON.stringify({
            rawCheckpointReleased: checked,
            loopTargetRetainedWhileActive,
            loopTargetReleasedAfterExit,
            runs: opened,
            closed,
            liveScopes: 0,
            baseline,
            samples,
            heapGrowth: samples.at(-1) - baseline
        }));
    } finally {
        ScopeManager.prototype.push = push;
        fs.rmSync(root, {recursive: true, force: true});
    }
})().catch(e => {
    console.error(e);
    process.exitCode = 1;
});

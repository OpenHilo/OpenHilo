const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    EvalEngine, ExecutionEngine, FailableError, AbortError, Rehydrator, RunManager, dispatchAiTask, HumanSuspendedError,
} = require('../dist');
const {startRun} = require('../dist/run-service');

function workspace(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-hardening-'));
    t.after(() => fs.rmSync(base, {recursive: true, force: true}));
    return base;
}

function runDirWith(base, snapshots) {
    const runDir = fs.mkdtempSync(path.join(base, 'run-'));
    fs.mkdirSync(path.join(runDir, 'io_records'));
    fs.mkdirSync(path.join(runDir, '.snapshot'));
    for (const [name, itt] of Object.entries(snapshots)) fs.writeFileSync(path.join(runDir, '.snapshot', name), JSON.stringify(itt));
    return runDir;
}

function engineFor(base, runDir, options = {}) {
    const statuses = [];
    const evalEngine = new EvalEngine();
    evalEngine.start();
    const engine = new ExecutionEngine({
        runId: 'run_x', runDir, workdir: base, snapshotDir: path.join(runDir, '.snapshot'), intentName: 'wf', inputs: {},
        evalEngine, runManager: {update_status: status => statuses.push(status)}, ...options,
    });
    return {engine, statuses};
}

async function execute(base, runDir, options) {
    const {engine, statuses} = engineFor(base, runDir, options);
    let result, error;
    try {
        result = await engine.run();
    } catch (caught) {
        error = caught;
    }
    const events = fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    return {result, error, statuses, events};
}

const code = (id, next, extra = {}) => ({
    id, type: 'call', executor: 'code', script: 'f', inputsFrom: {}, outputsTo: {}, outputs: {}, next, ...extra,
});
const assign = (id, assignments, next) => ({
    id, type: 'assign', assignments: Object.entries(assignments).map(([v, expr]) => ({var: v, expr})), next,
});

// ── Eval sandbox ─────────────────────────────────────────────────────────────

test('expressions cannot reach host intrinsics, constructors or process', async () => {
    const engine = new EvalEngine();
    for (const [expression, vars] of [
        ["Object.constructor('return process')()", {}],
        ["JSON.constructor.constructor('return process')()", {}],
        ["parseInt.constructor('return process')()", {}],
        ["this.constructor.constructor('return process')()", {}],
        ["x.constructor.constructor('return process')()", {x: {a: 1}}],
        ["x.map.constructor('return process')()", {x: [1]}],
        ["__openhilo_data_value__.constructor('return process')()", {}],
        ["(() => { try { null.x } catch (e) { return e.constructor.constructor('return process')() } })()", {}],
    ]) {
        await assert.rejects(engine.eval(expression, vars), /Code generation from strings disallowed/, expression);
    }
});

test('expressions cannot pollute host or later evaluations', async () => {
    const engine = new EvalEngine();
    assert.equal(await engine.eval("(Object.prototype.polluted = 'yes', JSON.parse = () => 42, Array.prototype.push = null, 1)", {}), 1);
    assert.equal(({}).polluted, undefined);
    assert.equal(JSON.parse('1'), 1);
    assert.equal(await engine.eval("({}).polluted ?? JSON.parse('7')", {}), 7);
    assert.deepEqual(await engine.eval('(q.push(4), q)', {q: [3]}), [3, 4]);
});

test('dynamic import and asynchronous code are rejected before execution', async () => {
    const engine = new EvalEngine();
    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on('unhandledRejection', onUnhandled);
    try {
        await assert.rejects(engine.eval('import("fs")', {}), /"import" is not supported/);
        await assert.rejects(engine.eval('1 / 2 + import("fs")', {}), /"import" is not supported/);
        await assert.rejects(engine.eval('(async () => { await 0; while (true) {} })()', {}), /"async" is not supported/);
        await assert.rejects(engine.eval('Promise.reject(1)', {}), /Promise is not defined/);
        assert.equal(await engine.eval('`please import (${x}) // async`', {x: 'it'}), 'please import (it) // async');
        assert.equal(await engine.eval('typeof Array.fromAsync + typeof Atomics.waitAsync + typeof WebAssembly', {}), 'undefinedundefinedundefined');
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(unhandled, 0);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('workflow data keeps identity and in-place mutation while results return as host values', async () => {
    const engine = new EvalEngine();
    const vars = {q: [{a: 1}], n: {deep: [1]}};
    assert.equal(await engine.eval('(q.push({b: [2]}), n.deep.shift(), q.length)', vars), 2);
    assert.deepEqual(vars, {q: [{a: 1}, {b: [2]}], n: {deep: []}});
    for (const value of [vars.q, vars.q[1], vars.q[1].b, vars.n.deep]) {
        assert.ok([Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value)));
    }
    const result = await engine.eval("({k: Object.keys({x: 1}), j: JSON.parse('{\"e\": [1]}'), m: [1].map(v => ({v}))})", {});
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.k), Array.prototype);
    assert.equal(Object.getPrototypeOf(result.j.e), Array.prototype);
    assert.equal(Object.getPrototypeOf(result.m[0]), Object.prototype);
    await assert.rejects(engine.eval('(x.push(new (class A {})), 1)', {x: []}), /non-plain prototype/);
});

// ── Resume does not replay input side effects ───────────────────────────────

const shiftWorkflow = (call) => ({
    version: 2, entry: 'init', outputs: {q: 'q', got: 'got'}, nodes: {
        init: assign('init', {q: '[1,2,3]'}, 'c'),
        c: {...call, id: 'c', inputsFrom: {item: 'q.shift()'}, next: 'END'},
    },
});

test('resume after an executor failure reuses the checkpointed inputs instead of re-evaluating them', async t => {
    const base = workspace(t);
    const runDir = runDirWith(base, {'wf.itt.json': shiftWorkflow(code('c', 'END', {outputs: {v: 'json'}, outputsTo: {v: 'got'}}))});
    let attempt = 0;
    const executor = async (_node, inputs) => {
        if (++attempt === 1) throw new FailableError('transient');
        return {outputs: {v: inputs.item}};
    };
    const first = await execute(base, runDir, {executor});
    assert.ok(first.error instanceof FailableError);
    const state = new Rehydrator(runDir).rehydrate();
    assert.deepEqual(state.callStack.at(-1).pending_call, {node_id: 'c', inputs: {item: 1}});
    const {engine} = engineFor(base, runDir, {executor, resumeFrom: {callStack: state.callStack, globalSeq: state.globalSeq}});
    const out = await engine.run();
    assert.equal(out.got, 1);
    assert.deepEqual(out.q, [2, 3]);
});

test('resume at a human step reuses its inputs; legacy checkpoints without them still resume', async t => {
    const base = workspace(t);
    const human = {type: 'call', executor: 'human', intent: 'ok?', outputs: {answer: 'text'}, outputsTo: {answer: 'got'}};
    for (const legacy of [false, true]) {
        const runDir = runDirWith(base, {'wf.itt.json': shiftWorkflow(human)});
        const first = await execute(base, runDir, {});
        assert.ok(first.error instanceof HumanSuspendedError);
        const state = new Rehydrator(runDir).rehydrate({answer: 'yes'});
        assert.equal(state.kind, 'ok');
        if (legacy) delete state.callStack.at(-1).pending_call;
        else assert.deepEqual(state.callStack.at(-1).pending_call.inputs, {item: 1});
        const {engine} = engineFor(base, runDir, {
            resumeFrom: {callStack: state.callStack, globalSeq: state.globalSeq}, pendingHumanOutput: state.pendingHumanOutput,
        });
        const out = await engine.run();
        assert.equal(out.got, 'yes');
        assert.deepEqual(out.q, legacy ? [3] : [2, 3]);
    }
});

// ── Engine failure handling ─────────────────────────────────────────────────

test('a plain executor Error is failable: on_failure runs, otherwise the run fails with a checkpoint', async t => {
    const base = workspace(t);
    const executor = async () => {
        throw new Error('boom');
    };
    const handled = await execute(base, runDirWith(base, {
        'wf.itt.json': {
            version: 2, entry: 'c', outputs: {h: 'h'}, nodes: {
                c: code('c', 'END', {on_failure: 'handler'}),
                handler: assign('handler', {h: '1'}, 'END'),
            }
        }
    }), {executor});
    assert.equal(handled.error, undefined);
    assert.equal(handled.result.h, 1);
    assert.ok(handled.events.some(e => e.event === 'node_failed' && e.on_failure === 'handler'));

    const failed = await execute(base, runDirWith(base, {'wf.itt.json': {version: 2, entry: 'c', nodes: {c: code('c', 'END')}}}), {executor});
    assert.ok(failed.error instanceof FailableError);
    assert.deepEqual(failed.events.slice(-2).map(e => e.event), ['run_failed', 'suspended_state']);
    assert.equal(failed.events.at(-2).failure.safeToReplay, false);
    assert.equal(failed.statuses.at(-1), 'failed');
});

test('on_failure leaving a loop unwinds its loop context; a handler inside the body keeps it', async t => {
    const base = workspace(t);
    let calls = 0;
    const out = await execute(base, runDirWith(base, {
        'wf.itt.json': {
            version: 2, entry: 'pre', outputs: {done: 'done'}, nodes: {
                pre: assign('pre', {pass: '0', log: '[]'}, 'loop'),
                loop: {id: 'loop', type: 'for', init: [{var: 'i', expr: '0'}], condition: 'i < 2', step: [{var: 'i', expr: 'i + 1'}], next_body: 'rec', next_exit: 'after'},
                rec: assign('rec', {log: '[...log, `p${pass}i${i}`]'}, 'c'),
                c: code('c', 'loop', {on_failure: 'catch'}),
                catch: assign('catch', {pass: 'pass + 1'}, 'again'),
                again: {id: 'again', type: 'if', condition: 'pass < 2', next_true: 'loop', next_false: 'after'},
                after: assign('after', {done: 'log'}, 'END'),
            }
        }
    }), {
        executor: async () => {
            if (++calls === 2) throw new FailableError('fail');
            return {outputs: {}};
        }
    });
    assert.equal(out.error, undefined);
    assert.deepEqual(out.result.done, ['p0i0', 'p0i1', 'p1i0', 'p1i1']);

    calls = 0;
    const inside = await execute(base, runDirWith(base, {
        'wf.itt.json': {
            version: 2, entry: 'pre', outputs: {done: 'log'}, nodes: {
                pre: assign('pre', {log: '[]'}, 'loop'),
                loop: {id: 'loop', type: 'for', init: [{var: 'i', expr: '0'}], condition: 'i < 3', step: [{var: 'i', expr: 'i + 1'}], next_body: 'c', next_exit: 'END'},
                c: code('c', 'ok', {on_failure: 'catch'}),
                ok: assign('ok', {log: '[...log, i]'}, 'loop'),
                catch: assign('catch', {log: '[...log, "e" + i]'}, 'loop'),
            }
        }
    }), {
        executor: async () => {
            if (++calls === 2) throw new FailableError('fail');
            return {outputs: {}};
        }
    });
    assert.deepEqual(inside.result.log, [0, 'e1', 2]);
});

test('a throwing event observer cannot kill the run', async t => {
    const base = workspace(t);
    const out = await execute(base, runDirWith(base, {'wf.itt.json': {version: 2, entry: 'a', outputs: {x: 'x'}, nodes: {a: assign('a', {x: '1'}, 'END')}}}), {
        onEvent(event) {
            if (event.event === 'node_success') throw new Error('observer bug');
        }
    });
    assert.equal(out.error, undefined);
    assert.equal(out.result.x, 1);
    assert.equal(out.events.at(-1).event, 'run_complete');
    assert.equal(out.statuses.at(-1), 'completed');
});

test('node run ids stay unique past 65536 steps', async t => {
    const base = workspace(t);
    const runDir = runDirWith(base, {'wf.itt.json': {version: 2, entry: 'a', nodes: {a: assign('a', {x: '1'}, 'END')}}});
    fs.writeFileSync(path.join(runDir, 'execution.jsonl'), '');
    const callStack = [{
        frame_id: 'run_x_f1', intent_name: 'wf', current_node: 'a', extension_state: [],
        scope_stack: [{kind: 'base', vars: {ITT_WORKSPACE: base}}], return_context: null,
    }];
    const out = await execute(base, runDir, {resumeFrom: {callStack, globalSeq: 0x10000}});
    assert.equal(out.events.find(e => e.event === 'node_pending').node_run_id, 'run_x_10000');
});

// ── Snapshots ───────────────────────────────────────────────────────────────

test('callee lookup stays inside the snapshot directory and callee ITTs are validated', async t => {
    const base = workspace(t);
    const runDir = runDirWith(base, {
        'wf.itt.json': {
            version: 2, entry: 'c', outputs: {r: 'r'}, nodes: {
                c: {id: 'c', type: 'call', executor: 'ai', callee: '../evil', intent: 'x', inputsFrom: {}, outputs: {r: 'text'}, outputsTo: {r: 'r'}, next: 'END'},
            }
        }
    });
    fs.writeFileSync(path.join(runDir, 'evil.itt.impl.json'), '{}');
    let calls = 0;
    const contained = await execute(base, runDir, {executor: async () => (calls++, {outputs: {r: 'leaf'}})});
    assert.equal(contained.error, undefined);
    assert.equal(contained.result.r, 'leaf');
    assert.equal(calls, 1);

    const invalid = await execute(base, runDirWith(base, {
        'wf.itt.json': {version: 2, entry: 'c', nodes: {c: {id: 'c', type: 'call', executor: 'intent', callee: 'sub', inputsFrom: {}, outputsTo: {}, next: 'END'}}},
        'sub.itt.impl.json': {version: 2, entry: 's', nodes: {s: {id: 's', type: 'call', executor: 'code', inputsFrom: {}, outputsTo: {}, next: 'END'}}},
    }), {executor: async () => ({outputs: {}})});
    assert.ok(invalid.error instanceof AbortError);
    assert.match(invalid.error.message, /ITT snapshot sub is invalid/);
    assert.equal(invalid.events.at(-1).event, 'run_abort');
});

// ── io_records ──────────────────────────────────────────────────────────────

test('io_records names cannot escape the directory or overwrite earlier records', async t => {
    const base = workspace(t);
    const runDir = runDirWith(base, {'wf.itt.json': {version: 2, entry: 'a', nodes: {a: assign('a', {x: '1'}, 'END')}}});
    const escaped = await execute(base, runDir, {inputs: {'../../../PWNED': 'x'.repeat(70000)}});
    assert.equal(escaped.error, undefined);
    const ref = escaped.events.find(e => e.event === 'inputs_inject').vars['../../../PWNED'];
    assert.equal(path.dirname(ref.path), 'io_records');
    assert.ok(fs.existsSync(path.join(runDir, ref.path)));
    assert.deepEqual(fs.readdirSync(base).filter(name => name.includes('PWNED')), []);

    const big = c => `'${c.repeat(70000)}'`;
    const sub = c => ({version: 2, entry: 's', outputs: {r: 'r'}, nodes: {s: assign('s', {r: big(c)}, 'END')}});
    const nested = runDirWith(base, {
        'wf.itt.json': {
            version: 2, entry: 'c1', outputs: {r: 'b'}, nodes: {
                c1: {id: 'c1', type: 'call', executor: 'intent', callee: 'sub', inputsFrom: {}, outputs: {r: 'text'}, outputsTo: {r: 'a'}, next: 'c2'},
                c2: {id: 'c2', type: 'call', executor: 'intent', callee: 'sub2', inputsFrom: {}, outputs: {r: 'text'}, outputsTo: {r: 'b'}, next: 'END'},
            }
        },
        'sub.itt.impl.json': sub('y'), 'sub2.itt.impl.json': sub('z'),
    });
    const out = await execute(base, nested, {});
    const refs = out.events.filter(e => e.event === 'frame_pop' || e.event === 'run_complete').map(e => e.outputs.r);
    assert.equal(new Set(refs.map(r => r.path)).size, refs.length);
    for (const ref of refs) {
        const hash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path.join(nested, ref.path))).digest('hex');
        assert.equal(hash, ref.hash);
    }
});

// ── Run service / manager / dispatch ────────────────────────────────────────

test('run directories cannot be placed outside runsDir by the intent name', t => {
    const base = workspace(t);
    const runsDir = path.join(base, 'runs');
    for (const intent of ['..', '../x', 'a/../../x', '/abs', 'a\\b', '', 'a//b', './a']) {
        assert.throws(() => RunManager.create({runsDir, intent, workdir: base}), /Invalid run intent/, intent);
    }
    const manager = RunManager.create({runsDir, intent: 'team/report', workdir: base});
    manager.release();
    assert.ok(manager.runDir.startsWith(path.join(runsDir, 'team', 'report') + path.sep));
});

test('a failed system executor leaves a consistently aborted run', async t => {
    const base = workspace(t);
    const entryFile = path.join(base, 'wf.itt.json');
    fs.writeFileSync(entryFile, JSON.stringify({version: 2, entry: 's', nodes: {s: {...code('s', 'END'), executor: 'sys'}}}));
    const result = await startRun({
        intent: 'wf', entryFile, workdir: path.join(base, 'w'), runsDir: path.join(base, 'runs'), inputs: {},
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, 'wf.itt.json')),
        createResources: () => ({
            executor: async () => {
                throw new FailableError('sys failed');
            }
        }),
    });
    assert.equal(result.status, 'aborted');
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.runDir, 'run.json'))).status, 'aborted');
});

test('AI file outputs are referenced by their checked real path', async t => {
    const base = workspace(t);
    fs.mkdirSync(path.join(base, 'real'));
    fs.writeFileSync(path.join(base, 'real', 'out.txt'), 'data');
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
    const node = {id: 'a', type: 'call', executor: 'ai', intent: 'x', inputsFrom: {}, outputs: {f: 'file'}, outputsTo: {f: 'f'}, next: 'END'};
    let released = 0;
    const executor = {
        id: 'offline', capabilities: ['workspace', 'structured_output'],
        async start() {
            return {result: Promise.resolve({status: 'completed', outputs: {f: 'link/out.txt'}, artifacts: [], session: {id: 's'}}), cancel: async () => {}};
        },
        async releaseSession() {
            released++;
        },
    };
    const {outputs} = await dispatchAiTask(node, {}, {workdir: base}, executor);
    assert.equal(released, 1);
    assert.equal(outputs.f.type, 'file_ref');
    assert.equal(outputs.f.path, path.join('real', 'out.txt'));
});

test('import/async screening distinguishes division from regex without rejecting ordinary text', async () => {
    const engine = new EvalEngine();
    engine.start();
    const vars = {x: 8, s: 'a/import/b', o: {import: 1, async: 2}};
    for (const [expr, expected] of [
        ['"please import " + (x / 2)', 'please import 4'],
        ['`async total: ${x / 4}`', 'async total: 2'],
        ['o.import + o.async', 3],
        ['/import/.test(s)', true],
        ['x / 2 / 2', 2],
        ['[x].map(v => v / 2)[0]', 4],
    ]) assert.deepEqual(await engine.eval(expr, vars, {fileReferences: 'data'}), expected, expr);
    for (const expr of [
        '[...import("fs")]',
        'x / 2, import("fs"), 1 / 1',
        'ä / 2, import("fs"), 1 / 1',
        '(1) / import("fs")',
        'typeof /x/ + import("fs")',
        'x++ / 2 + import("fs") / 3',
        '`${import("fs")}`',
        'x. /**/ async',
        '(async () => 1)()',
    ]) await assert.rejects(engine.eval(expr, vars, {fileReferences: 'data'}), /not supported|evaluation error/, expr);
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {ScopeManager, EvalEngine, Logger, AbortError} = require('../dist');
const {isJsonValue} = require('@openhilo/ai-contracts');
const invalid = () => {
    const cycle = {};
    cycle.self = cycle;
    return [undefined, NaN, Infinity, -Infinity, -0, 1n, () => {
    }, Symbol('x'),
        {nested: undefined}, [undefined], [1, , 3], cycle, new Date(), new Map(),
        new Set(), /x/, new Number(1), Promise.resolve(1), new Uint8Array([1]),
        Object.assign([1], {extra: true}), {[Symbol('hidden')]: 1},
        Object.defineProperty({}, 'hidden', {value: 1}), new (class Item {
            value = 1;
        })(),
    ];
};

test('scope rejects lossy values before replacing existing state and preserves nested values across snapshots', () => {
    const scope = new ScopeManager();
    scope.push({kind: 'base', vars: {}});
    scope.write('keep', {n: 1});
    for (const value of invalid()) {
        assert.throws(() => scope.write('keep', value), AbortError);
        assert.deepEqual(scope.read('keep'), {n: 1});
    }
    const shared = {n: 2};
    scope.write('data', {first: shared, second: shared, nil: null, array: [true, 'x']});
    scope.write('__proto__', {ordinary: true});
    const snapshot = scope.serialize();
    shared.n = 3;
    const restored = new ScopeManager();
    restored.deserialize(JSON.parse(JSON.stringify(snapshot)));
    assert.equal(restored.read('data').first.n, 2);
    assert.deepEqual(restored.read('__proto__'), {ordinary: true});
    assert.equal(Object.getPrototypeOf(restored.visible_vars()), Object.prototype);
    snapshot[0].vars.data.first.n = 9;
    assert.equal(restored.read('data').first.n, 2);
    const before = restored.serialize();
    assert.throws(() => restored.deserialize([{kind: 'base', vars: {bad: Infinity}}]), AbortError);
    assert.deepEqual(restored.serialize(), before);
});

test('validation does not invoke accessors, toJSON or proxy traps and accepts plain VM data', () => {
    let calls = 0;
    const scope = new ScopeManager();
    scope.push({kind: 'base', vars: {}});
    const values = [
        {
            get value() {
                calls++;
                return 1;
            }
        },
        {
            toJSON() {
                calls++;
                return {};
            }
        },
        new Proxy({}, {
            ownKeys() {
                calls++;
                return [];
            }
        }),
        Object.create({
            constructor: Object, toJSON() {
                calls++;
                return {};
            }
        }),
    ];
    for (const value of values) assert.throws(() => scope.write('bad', value), AbortError);
    assert.equal(calls, 0);
    const value = vm.runInNewContext('({ array: [1, { good: true }], n: null })');
    scope.write('vm', value);
    assert.deepEqual(JSON.parse(JSON.stringify(scope.serialize()))[0].vars.vm, {array: [1, {good: true}], n: null});
});

test('evaluator rejects non-JSON results before Promise assimilation and detects invalid in-place mutation', async () => {
    const engine = new EvalEngine();
    for (const expression of ['1 / 0', 'NaN', '({ missing: undefined })', '[1,,3]', '(() => 1)',
        'Promise.resolve(1)', '({ get then() { throw new Error("must not invoke"); } })']) {
        await assert.rejects(engine.eval(expression, {}), /JSON-compatible/);
    }
    await assert.rejects(engine.eval('(items.push(NaN), true)', {items: [1]}), /JSON-compatible/);
    assert.equal(await engine.eval('data?.missing', {data: {}}), undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(await engine.eval('[1,2].map(x => ({n:x+1}))', {}))), [{n: 2}, {n: 3}]);
});

test('evaluator returns nested VM objects and arrays as host JSON contract values', async () => {
    const engine = new EvalEngine();
    const result = await engine.eval('({ tags: { _lifecycle: "Active" }, items: [1, { good: true }], ["__proto__"]: { ordinary: true } })', {});
    assert.equal(isJsonValue(result), true);
    assert.deepEqual(result, JSON.parse('{"tags":{"_lifecycle":"Active"},"items":[1,{"good":true}],"__proto__":{"ordinary":true}}'));
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.getPrototypeOf(result.items), Array.prototype);
});

test('logger rejects invalid data before appending or creating external value records', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-values-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    fs.mkdirSync(path.join(directory, 'io_records'));
    const logger = new Logger(directory, 'values');
    logger.init();
    for (const value of invalid()) {
        assert.throws(() => logger.append({
            event: 'node_success',
            ts: 1,
            node_run_id: 'n',
            outputs: {large: 'x'.repeat(70000), value}
        }), AbortError);
        assert.throws(() => logger.write_inputs_record('n', {value}), AbortError);
    }
    assert.equal(fs.readFileSync(path.join(directory, 'execution.jsonl'), 'utf8'), '');
    assert.deepEqual(fs.readdirSync(path.join(directory, 'io_records')), []);
    assert.throws(() => logger.append({
        event: 'suspended_state', ts: 1, global_seq: 1,
        call_stack: [{frame_id: 'frame', scope_stack: [{kind: 'loop-context', vars: {}, array: [undefined]}]}]
    }), AbortError);
    const outputs = JSON.parse('{"__proto__":{"ordinary":true}}');
    logger.append({event: 'node_success', ts: 1, node_run_id: 'n', outputs});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'execution.jsonl'), 'utf8')).outputs, outputs);
});

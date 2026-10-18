const {test} = require('node:test');
const assert = require('node:assert/strict');
const {RuntimeExtensions} = require('../dist');
const policy = (overrides = {}) => ({
    namespace: 'example.policy', version: 1,
    derive: ({parent}) => ({depth: (parent?.depth ?? 0) + 1}),
    restore: ({state}) => state,
    ...overrides,
});

test('derives and restores namespaced state; defaults to an empty generic context', () => {
    assert.deepEqual(new RuntimeExtensions().derive({}), []);
    const registry = new RuntimeExtensions([policy()]);
    const root = registry.derive({});
    assert.deepEqual(registry.derive({}, root)[0].data, {depth: 2});
    assert.deepEqual(registry.restore({}, root), root);
});

test('validates extension identity, requirements and saved versions', () => {
    assert.throws(() => new RuntimeExtensions([policy(), policy()]), /duplicate/);
    assert.throws(() => new RuntimeExtensions([policy({version: 0})]), /Invalid/);
    assert.throws(() => new RuntimeExtensions().derive({
        requiredExtensions: [{
            namespace: 'example.policy',
            version: 1
        }]
    }), /Missing compatible/);
    const registry = new RuntimeExtensions([policy()]);
    assert.throws(() => registry.restore({}, [{
        namespace: 'example.policy',
        version: 2,
        data: {}
    }]), /Missing compatible/);
    assert.throws(() => registry.restore({}, [{namespace: 'unknown', version: 1, data: {}}]), /Missing compatible/);
    assert.throws(() => registry.restore({}, [null]), /Invalid/);
    const state = registry.derive({});
    assert.throws(() => registry.restore({}, [...state, ...state]), /duplicate/);
    assert.throws(() => registry.derive({requiredExtensions: [{namespace: 'example.policy', version: -1}]}), /Invalid/);
});

test('new snapshots require exactly the original extension set; legacy migration is explicit', () => {
    const registry = new RuntimeExtensions([policy()]);
    assert.throws(() => registry.restore({}, undefined), /explicit migration/);
    assert.deepEqual(registry.restore({}, undefined, [], true), registry.derive({}));
    assert.throws(() => registry.restore({}, []), /set changed/);
    assert.throws(() => new RuntimeExtensions().restore({}, registry.derive({})), /Missing compatible/);
});

test('isolates policy inputs, outputs and persisted data from mutation', () => {
    const workflow = {nested: {value: 'original'}};
    const parent = [{namespace: 'example.policy', version: 1, data: {depth: 4}}];
    const shared = {depth: 5};
    const registry = new RuntimeExtensions([policy({
        derive: ({workflow, parent}) => {
            workflow.nested.value = 'mutated';
            parent.depth = 100;
            return shared;
        }, restore: ({state}) => {
            state.depth = 8;
            return state;
        }
    })]);
    const result = registry.derive(workflow, parent);
    shared.depth = 99;
    assert.equal(workflow.nested.value, 'original');
    assert.equal(parent[0].data.depth, 4);
    assert.equal(result[0].data.depth, 5);
    assert.equal(registry.restore({}, result)[0].data.depth, 8);
    assert.equal(result[0].data.depth, 5);
});

test('rejects non-JSON extension results before persistence', () => {
    for (const invalid of [undefined, [], {value: NaN}, {value: new Date()}, {
        value: () => {
        }
    }]) {
        assert.throws(() => new RuntimeExtensions([policy({derive: () => invalid})]).derive({}), /Non-serializable/);
    }
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => new RuntimeExtensions([policy({derive: () => cycle})]).derive({}), /Non-serializable/);
});

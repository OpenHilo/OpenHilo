const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ScopeManager, encodeStateGraph, decodeStateGraph, decodeCheckpointStack} = require('../dist');
test('graph roundtrip preserves sharing, distinct equal objects and reserved keys without live ownership', () => {
    const a = {n: 1}, b = {n: 1};
    const source = {
        a,
        alias: a,
        b,
        items: [a, b],
        nested: {a},
        reserved: JSON.parse('{"__proto__":{"ref":1},"constructor":0}')
    };
    const saved = encodeStateGraph(source);
    const out = decodeStateGraph(JSON.parse(JSON.stringify(saved)));
    assert.equal(out.a, out.alias);
    assert.equal(out.items[0], out.nested.a);
    assert.notEqual(out.a, out.b);
    assert.notEqual(out.a, a);
    assert.deepEqual(out.reserved, source.reserved);
    out.a.n = 4;
    assert.equal(a.n, 1);
    assert.equal(out.alias.n, 4);
});
test('checkpoint decoder reads legacy trees without guessing equal-object aliases', () => {
    const legacy = [{
        frame_id: 'f',
        intent_name: 'a',
        current_node: 'n',
        scope_stack: [{kind: 'base', vars: {a: {n: 1}, b: {n: 1}}}],
        return_context: null
    }];
    const restored = decodeCheckpointStack(legacy);
    assert.deepEqual(restored, legacy);
    assert.notEqual(restored[0].scope_stack[0].vars.a, restored[0].scope_stack[0].vars.b);
});
test('invalid graph versions, references, records and cycles fail explicitly', () => {
    const good = () => ({
        format: 'openhilo-state-graph',
        version: 1,
        root: {ref: 0},
        nodes: [{kind: 'object', entries: [['n', 1]]}]
    });
    const bad = [{...good(), version: 2}, {...good(), format: 'other'}, {...good(), root: {ref: 5}},
        {...good(), root: {ref: -1}}, {...good(), root: {ref: 0, extra: true}},
        {...good(), nodes: [{kind: 'object', entries: [['a', 1], ['a', 2]]}]},
        {...good(), nodes: [{kind: 'object', entries: [['self', {ref: 0}]]}]},
        {...good(), nodes: [{kind: 'other'}]}, {...good(), nodes: [{kind: 'array', items: [{ref: 8}]}]}];
    for (const graph of bad) assert.throws(() => decodeStateGraph(graph), /graph|cycle|state/i);
    assert.throws(() => decodeCheckpointStack(good()), /stack|frame|array/i);
});
for (const [name, make] of [
    ['frozen object', () => Object.freeze({n: 1})], ['sealed object', () => Object.seal({n: 1})],
    ['nonextensible', () => Object.preventExtensions({n: 1})], ['readonly', () => Object.defineProperty({n: 1}, 'n', {writable: false})],
    ['nonconfigurable', () => Object.defineProperty({n: 1}, 'n', {configurable: false})],
    ['null prototype', () => Object.assign(Object.create(null), {n: 1})],
    ['readonly array length', () => Object.defineProperty([1], 'length', {writable: false})],
]) test('unsupported retained state rejects ' + name, () => {
    const scope = new ScopeManager();
    scope.push({kind: 'base', vars: {}});
    scope.write('x', 1);
    assert.throws(() => scope.write('x', make()), /JSON-compatible|plain|descriptor|extensible|prototype/i);
    assert.equal(scope.read('x'), 1);
});

test('copied native-looking prototypes are rejected before normalization', () => {
    const fake = Object.create(null, Object.getOwnPropertyDescriptors(Object.prototype));
    const scope = new ScopeManager();
    scope.push({kind: 'base', vars: {}});
    assert.throws(() => scope.write('x', Object.setPrototypeOf({n: 1}, fake)), /prototype|plain/i);
});
test('diagnostics keep highly shared DAGs bounded in outputs, input records and loop events', t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const {Logger} = require('../dist');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-dag-log-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'io_records'));
    const logger = new Logger(dir, 'dag');
    logger.init();
    let data = {n: 1};
    for (let i = 0; i < 18; i++) data = {left: data, right: data};
    logger.append({event: 'node_success', ts: 1, node_run_id: 'n', outputs: {data}});
    logger.write_inputs_record('n', {data});
    logger.append({
        event: 'continue_inline',
        ts: 1,
        trigger_node_run_id: 'n',
        loop_node_id: 'loop',
        step_results: {data},
        condition_result: true,
        next: 'body'
    });
    const events = fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(fs.statSync(path.join(dir, 'execution.jsonl')).size < 20000);
    for (const file of fs.readdirSync(path.join(dir, 'io_records'))) assert.ok(fs.statSync(path.join(dir, 'io_records', file)).size < 20000, 'compact DAG must not expand in ' + file);
    const ref = events[0].outputs.data;
    assert.equal(ref.type, 'file_ref');
    assert.match(ref.path, /\.graph\.json$/);
    const out = decodeStateGraph(JSON.parse(fs.readFileSync(path.join(dir, ref.path), 'utf8')));
    assert.equal(out.left, out.right);
    const input = decodeStateGraph(JSON.parse(fs.readFileSync(path.join(dir, 'io_records/n_inputs.json'), 'utf8')));
    assert.equal(input.data.left, input.data.right);
    assert.equal(events[1].step_results.data.type, 'file_ref');
});

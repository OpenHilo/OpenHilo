const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {IttValidator} = require('../dist');

const v = new IttValidator();
const assign = (id, next) => ({id, type: 'assign', assignments: [], next});
const graph = (nodes, extra = {}) => ({version: 2, entry: Object.keys(nodes)[0], nodes, ...extra});
const errorsOf = itt => v.validate(itt).errors.join('\n');

test('malformed graphs return errors instead of throwing', () => {
    const cases = [
        [null, /ITT must be an object/],
        [[], /ITT must be an object/],
        [{version: 2, entry: 'a', nodes: null}, /"nodes" must be an object/],
        [{version: 2, entry: 'a', nodes: []}, /"nodes" must be an object/],
        [graph({a: null}), /Node "a" must be an object/],
        [graph({a: {id: 'a', type: 'while', next: 'END'}}), /unknown type "while"/],
        [graph({a: {id: 'a', next: 'END'}}), /unknown type undefined/],
        [graph({a: assign('a', 'END')}, {entry: 'constructor'}), /Entry node "constructor" does not exist/],
        [graph({a: assign('a', 'END')}, {entry: 'toString'}), /Entry node "toString" does not exist/],
        [graph({a: assign('a', 'END')}, {entry: undefined}), /Entry node "undefined" does not exist/],
        [graph({a: assign('a', 'constructor')}), /references non-existent node "constructor"/],
        [graph({a: assign('a', 'END')}, {version: 3}), /Unsupported ITT version 3/],
        [{entry: 'a', nodes: {a: assign('a', 'END')}}, /Unsupported ITT version undefined/],
        [graph({a: assign('b', 'END')}), /Node "a" has mismatched id "b"/],
        [graph({a: assign('a', 7)}), /field "next" must be a nonempty node ID string/],
        [graph({a: {id: 'a', type: 'if', condition: 'x', next_true: 'END'}}), /field "next_false" must be/],
        [graph({a: {id: 'a', type: 'for', init: [], step: [], condition: 'x', next_body: ['END'], next_exit: 'END'}}), /field "next_body" must be/],
        [graph({a: {id: 'a', type: 'call', executor: 'magic', inputsFrom: {}, outputsTo: {}, next: 'END'}}), /unsupported executor "magic"/],
        [graph({a: {id: 'a', type: 'call', executor: 'human', inputsFrom: {}, outputsTo: {}, on_failure: null, next: 'END'}}), /field "on_failure" must be/],
    ];
    for (const [itt, expected] of cases) {
        let result;
        assert.doesNotThrow(() => { result = v.validate(itt); }, JSON.stringify(itt));
        assert.match(result.errors.join('\n'), expected, JSON.stringify(itt));
    }
    assert.deepEqual(v.validate(graph({a: assign('a', 'END')}, {version: '2.0'})).errors, []);
    const nullPrototype = Object.assign(Object.create(null), {a: assign('a', 'END')});
    assert.deepEqual(v.validate({version: 2, entry: 'a', nodes: nullPrototype}).errors, []);
});

test('20000-node chains and loops validate without stack overflow', () => {
    const nodes = {};
    for (let i = 0; i < 20000; i++) nodes[`n${i}`] = assign(`n${i}`, i === 19999 ? 'BREAK' : `n${i + 1}`);
    nodes.loop = {id: 'loop', type: 'foreach', array_expr: 'xs', item_var: 'x', next_body: 'n0', next_exit: 'END'};
    const result = v.validate({version: 2, entry: 'loop', nodes});
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    nodes.n19999.next = 'END';
    assert.deepEqual(v.validate({version: 2, entry: 'n0', nodes}).errors, []);
});

test('BREAK and CONTINUE after a loop exit use the enclosing loop context', () => {
    const loop = (id, body, exit) => ({id, type: 'for', init: [], step: [], condition: 'x', next_body: body, next_exit: exit});
    // Top-level loop: code after next_exit is outside every loop.
    assert.match(errorsOf(graph({l: loop('l', 'b', 'after'), b: assign('b', 'l'), after: assign('after', 'BREAK')})),
        /BREAK used outside of a loop context \(at node "after"\)/);
    assert.match(errorsOf(graph({l: loop('l', 'b', 'CONTINUE'), b: assign('b', 'l')})), /CONTINUE used outside/);
    // Nested loop: after the inner exit, the outer loop still encloses the path.
    const nested = graph({
        outer: loop('outer', 'inner', 'END'),
        inner: loop('inner', 'body', 'afterInner'),
        body: assign('body', 'CONTINUE'),
        afterInner: assign('afterInner', 'BREAK'),
    });
    assert.deepEqual(v.validate(nested).errors, []);
    // Returning to the outer loop head discards the inner loop context.
    const backEdge = graph({
        outer: loop('outer', 'inner', 'done'),
        inner: loop('inner', 'body', 'outer'),
        body: assign('body', 'inner'),
        done: assign('done', 'CONTINUE'),
    });
    assert.match(errorsOf(backEdge), /CONTINUE used outside of a loop context \(at node "done"\)/);
    assert.deepEqual(v.validate(graph({l: loop('l', 'BREAK', 'END')})).errors, []);
});

test('references are checked on every node while unreachability remains a warning', () => {
    const result = v.validate(graph({a: assign('a', 'END'), orphan: assign('orphan', 'missing'), aborts: assign('aborts', 'ABORT')}));
    assert.match(result.errors.join('\n'), /Node "orphan" references non-existent node "missing"/);
    assert.match(result.errors.join('\n'), /Node "aborts" uses ABORT in field "next"/);
    assert.deepEqual(result.warnings, ['Node "orphan" is unreachable from entry', 'Node "aborts" is unreachable from entry']);
    assert.doesNotMatch(result.errors.join('\n'), /§/);
    const clean = v.validate(graph({a: assign('a', 'END'), orphan: assign('orphan', 'END')}));
    assert.deepEqual(clean.errors, []);
    assert.deepEqual(clean.warnings, ['Node "orphan" is unreachable from entry']);
});

test('ITT and call input kinds and shapes are validated', () => {
    const call = inputs => graph({c: {id: 'c', type: 'call', executor: 'human', inputs, inputsFrom: {}, outputsTo: {}, next: 'END'}});
    const valid = {kind: 'json', shape: {type: 'array', items: {type: 'number'}}};
    assert.deepEqual(v.validate(graph({a: assign('a', 'END')}, {inputs: {x: valid}})).errors, []);
    assert.deepEqual(v.validate(call({x: valid, y: {kind: 'text', shape: undefined}})).errors, []);
    for (const [definition, expected] of [
        [{kind: 'string'}, /has unsupported kind "string"/],
        [{}, /has unsupported kind undefined/],
        [null, /must be an object/],
        [{kind: 'json', shape: {type: 'array'}}, /has an invalid shape/],
        [{kind: 'json', shape: {type: 'mystery'}}, /has an invalid shape/],
        [{kind: 'json', shape: {type: 'object', properties: {}, numericKeys: true}}, /has an invalid shape/],
        [{kind: 'json', shape: {type: 'tuple', items: [{shape: {type: 'text'}, rest: true}, {shape: {type: 'number'}, rest: true}]}}, /has an invalid shape/],
    ]) {
        assert.match(errorsOf(graph({a: assign('a', 'END')}, {inputs: {x: definition}})), new RegExp(`ITT input "x" ${expected.source}`));
        assert.match(errorsOf(call({x: definition})), new RegExp(`Call node "c" input "x" ${expected.source}`));
    }
    assert.match(errorsOf(graph({a: assign('a', 'END')}, {inputs: []})), /ITT inputs must be an object/);
    assert.match(errorsOf(graph({c: {id: 'c', type: 'call', executor: 'human', outputs: {ok: 'bool'}, inputsFrom: {}, outputsTo: {}, next: 'END'}})),
        /output "ok" has unsupported type "bool"/);
});

test('validator and type sources cite only documents that exist', () => {
    const root = path.resolve(__dirname, '../../..');
    for (const file of ['validator.ts', 'index.ts']) {
        const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
        for (const [ref] of source.matchAll(/(?:docs|packages)\/[\w./-]+\.md/g)) assert.ok(fs.existsSync(path.join(root, ref)), `${file}: ${ref}`);
        assert.doesNotMatch(source, /ts-subset-spec|itt-format-spec|code-executor-abi|scheduler-architecture/);
    }
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {IttValidator, isFileRef} = require('../dist');

test('standalone graph validation rejects dangling control flow and invalid loop jumps', () => {
    const validator = new IttValidator();
    const valid = {
        version: 2,
        entry: 'start',
        nodes: {start: {id: 'start', type: 'assign', assignments: [], next: 'END'}}
    };
    assert.deepEqual(validator.validate(valid).errors, []);
    for (const target of ['missing', 'BREAK', 'CONTINUE']) {
        const graph = JSON.parse(JSON.stringify(valid));
        graph.nodes.start.next = target;
        assert.ok(validator.validate(graph).errors.length);
    }
});
test('file references retain the v2 compatibility shape', () => {
    assert.equal(isFileRef({type: 'file_ref', path: 'result.txt', hash: 'sha256:fixture', mtime: 1}), true);
    assert.equal(isFileRef('result.txt'), false);
});

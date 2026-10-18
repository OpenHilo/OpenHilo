const {test} = require('node:test');
const assert = require('node:assert/strict');
const {IttValidator} = require('../dist');
test('expression semantics metadata is explicit and validated', () => {
    const base = {
        version: 2,
        name: 'probe',
        entry: 'start',
        nodes: {start: {id: 'start', type: 'assign', assignments: [{var: 'x', type: 'number', expr: '1'}], next: 'END'}}
    };
    const v = new IttValidator();
    for (const metadata of [{}, {expressionSemantics: 'plain-data'}]) assert.deepEqual(v.validate({...base, ...metadata}).errors, []);
    for (const value of [null, 'legacy-path', 'future', 1]) assert.match(v.validate({
        ...base,
        expressionSemantics: value
    }).errors.join(' '), /expressionSemantics/);
});

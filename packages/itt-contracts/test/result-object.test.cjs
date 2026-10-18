const {test} = require('node:test');
const assert = require('node:assert/strict');
const {IttValidator} = require('../dist');
const fixture = () => ({
    version: 2,
    entry: 'call',
    nodes: {
        call: {
            id: 'call',
            type: 'call',
            executor: 'intent',
            callee: 'child',
            inputsFrom: {},
            outputsTo: {},
            next: 'END'
        }
    }
});
test('optional whole-result metadata is validated while legacy artifacts remain valid', () => {
    const v = new IttValidator();
    const legacy = fixture();
    assert.deepEqual(v.validate(legacy).errors, []);
    const valid = fixture();
    valid.resultVar = 'result';
    valid.nodes.call.resultTo = 'childResult';
    assert.deepEqual(v.validate(valid).errors, []);
    for (const bad of ['', ' ', 2, null, {}]) {
        const a = fixture();
        a.resultVar = bad;
        assert.match(v.validate(a).errors.join(' '), /resultVar/);
        const b = fixture();
        b.nodes.call.resultTo = bad;
        assert.match(v.validate(b).errors.join(' '), /resultTo/);
    }
    const external = fixture();
    external.nodes.call.executor = 'ai';
    external.nodes.call.resultTo = 'result';
    assert.match(v.validate(external).errors.join(' '), /resultTo/);
});

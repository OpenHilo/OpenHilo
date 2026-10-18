const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EvalEngine} = require('../dist');
test('explicit plain-data evaluation preserves file-shaped records while legacy evaluation projects paths', async () => {
    const e = new EvalEngine(), value = {type: 'file_ref', path: 'report.txt', hash: 'h', mtime: 1};
    assert.equal(await e.eval('value', {value}, {fileReferences: 'data'}), value);
    assert.equal(await e.eval('value', {value}), 'report.txt');
    assert.deepEqual(await e.eval('[value===box.value,typeof value]', {
        value,
        box: {value}
    }, {fileReferences: 'data'}), [true, 'object']);
});

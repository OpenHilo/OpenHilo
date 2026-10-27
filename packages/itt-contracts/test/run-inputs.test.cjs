const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseRunInputs, validateRunInputWire, RunInputError} = require('@openhilo/itt-contracts/run-inputs');
const schema = {flag: {kind: 'boolean'}, count: {kind: 'number'}, data: {kind: 'json'}, text: {kind: 'text'}};

test('explicit typed wire preserves booleans, finite numbers, JSON values and literal text in CJS and ESM', async () => {
    const esm = await import('@openhilo/itt-contracts/run-inputs');
    for (const data of [null, {nested: [false, 0, 'text']}, [1, 2], 'true', 'null', '{"literal":true}', '']) {
        const wire = {flag: 'true', count: '-1.25e2', data: JSON.stringify(data), text: '  keep  '};
        const expected = {flag: true, count: -125, data, text: '  keep  '};
        assert.deepEqual(parseRunInputs(wire, schema, 'typed-text-v1'), expected);
        assert.deepEqual(esm.parseRunInputs(wire, schema, 'typed-text-v1'), expected);
    }
    assert.equal(parseRunInputs({flag: 'false'}, {flag: schema.flag}, 'typed-text-v1').flag, false);
    const special = JSON.parse('{"__proto__":"own"}');
    assert.deepEqual(parseRunInputs(special, JSON.parse('{"__proto__":{"kind":"text"}}'), 'typed-text-v1'), special);
});

test('legacy inputs retain their old coercion while typed encoding rejects incomplete and ambiguous requests', () => {
    assert.deepEqual(parseRunInputs({flag: '1', count: '0x10', data: '{"keep":"string"}', extra: 'keep'}, schema),
        {flag: true, count: 16, data: '{"keep":"string"}', extra: 'keep'});
    for (const raw of [null, [], {flag: true}, {count: 1}, {data: {}}]) assert.throws(() => validateRunInputWire(raw), RunInputError);
    assert.throws(() => validateRunInputWire({}, 'future'), /encoding/);
    assert.throws(() => parseRunInputs({}, schema, 'typed-text-v1'), /Missing/);
    assert.throws(() => parseRunInputs({unexpected: 'value'}, {}, 'typed-text-v1'), /Unknown/);
    for (const [kind, values] of Object.entries({
        boolean: ['1', 'yes', 'TRUE'],
        number: ['', '1x', '1e999', '0x10', '-0'],
        json: ['unquoted', '[1e999]', '[-0]', '{bad']
    })) {
        for (const value of values) assert.throws(() => parseRunInputs({field: value}, {field: {kind}}, 'typed-text-v1'), RunInputError);
    }
});

test('legacy number inputs reject empty, non-numeric and non-finite strings', () => {
    assert.equal(parseRunInputs({count: ' 7 '}, schema).count, 7);
    for (const value of ['', '   ', 'abc', '1x', 'Infinity', '1e999']) {
        assert.throws(() => parseRunInputs({count: value}, schema), error => error instanceof RunInputError && error.field === 'count' &&
            /Invalid number run input: count/.test(error.message));
    }
});

test('input shapes are validated strictly before values are checked', async () => {
    const cjs = require('@openhilo/itt-contracts/run-inputs');
    const {validateInputShape, isInputShape} = cjs;
    const esm = await import('@openhilo/itt-contracts/run-inputs');
    for (const shape of [
        {type: 'array'},
        {type: 'mystery'},
        {type: 'object', properties: {}, numericKeys: false},
        {type: 'tuple', items: [{shape: {type: 'text'}, rest: true}, {shape: {type: 'text'}, rest: true}]},
    ]) {
        for (const module of [cjs, esm]) {
            assert.equal(module.isInputShape(shape), false, JSON.stringify(shape));
            assert.throws(() => module.validateInputShape([], shape, 'field'), error => error instanceof module.RunInputError && error.message === 'field: invalid input shape');
        }
        assert.throws(() => parseRunInputs({field: '[]'}, {field: {kind: 'json', shape}}, 'typed-text-v1'), /field: invalid input shape/);
    }
    for (const shape of [
        {type: 'object', properties: {}, additional: {type: 'number'}, numericKeys: true},
        {type: 'tuple', items: [{shape: {type: 'text'}}, {shape: {type: 'number'}, rest: true}]},
    ]) assert.equal(isInputShape(shape), true, JSON.stringify(shape));
    assert.throws(() => validateInputShape(['a', 'b'], {type: 'tuple', items: [{shape: {type: 'text'}}, {shape: {type: 'number'}, rest: true}]}), /tuple items/);
});

test('file references require a finite mtime', () => {
    const {isFileRef} = require('@openhilo/itt-contracts');
    for (const mtime of [NaN, Infinity, -Infinity]) assert.equal(isFileRef({type: 'file_ref', path: 'a', hash: 'sha256:x', mtime}), false);
    assert.equal(isFileRef({type: 'file_ref', path: 'a', hash: 'sha256:x', mtime: 0}), true);
});

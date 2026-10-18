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

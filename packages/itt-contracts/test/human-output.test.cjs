const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseHumanOutputs, parseHumanOutputValue, HumanOutputError} = require('@openhilo/itt-contracts/human-output');

test('human wire values have explicit finite types and preserve text and legacy path strings', () => {
    assert.deepEqual(parseHumanOutputs({
                text: '  note  ',
                number: ' -1.25e2 ',
                flag: 'false',
                data: '[null,{"enabled":true}]',
                file: '/tmp/file',
                dir: '/tmp/dir'
            },
            {text: 'text', number: 'number', flag: 'boolean', data: 'json', file: 'file', dir: 'dir'}),
        {
            text: '  note  ',
            number: -125,
            flag: false,
            data: [null, {enabled: true}],
            file: '/tmp/file',
            dir: '/tmp/dir'
        });
    assert.equal(parseHumanOutputValue('', 'text', 'empty'), '');
    assert.equal(parseHumanOutputValue('.5', 'number', 'n'), 0.5);
    assert.equal(parseHumanOutputValue('1.', 'number', 'n'), 1);
});

test('partial numeric parses, nonfinite JSON and incomplete or extra output fields are rejected', () => {
    for (const value of ['12abc', 'Infinity', '-Infinity', '1e999', '', '  ', '0x10', 'NaN', '1,000']) {
        assert.throws(() => parseHumanOutputValue(value, 'number', 'n'), HumanOutputError);
    }
    for (const value of ['1e999', '{"n":1e999}', '[1e999]', '{broken']) assert.throws(() => parseHumanOutputValue(value, 'json', 'j'), /Invalid JSON/);
    for (const value of ['1', '0', 'TRUE', '', ' true ']) assert.throws(() => parseHumanOutputValue(value, 'boolean', 'b'), /Invalid boolean/);
    assert.throws(() => parseHumanOutputs({n: 1}, {n: 'number'}), /must be a string/);
    assert.throws(() => parseHumanOutputs({}, {n: 'number'}), /Missing human output field/);
    assert.throws(() => parseHumanOutputs({n: '1', extra: '2'}, {n: 'number'}), /Unknown human output field/);
    assert.throws(() => parseHumanOutputs([], {}), /must be an object/);
    assert.throws(() => parseHumanOutputs(Object.create({n: '1'}), {n: 'number'}), /Missing human output field/);
});


test('browser ESM and server CommonJS entries enforce the same human value contract', async () => {
    const esm = await import('@openhilo/itt-contracts/human-output');
    assert.deepEqual(esm.parseHumanOutputs({n: '1e2'}, {n: 'number'}), parseHumanOutputs({n: '1e2'}, {n: 'number'}));
    assert.throws(() => esm.parseHumanOutputValue('1x', 'number', 'n'), /Invalid number/);
});

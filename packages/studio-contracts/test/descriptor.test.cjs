const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseStudioApplication, GENERIC_STUDIO_APPLICATION} = require('../dist');

test('generic descriptor contains no domain rules and depends only on shared contracts', () => {
    assert.deepEqual(parseStudioApplication(GENERIC_STUDIO_APPLICATION), {
        version: 1,
        id: 'generic',
        title: 'OpenHilo',
        tags: {}
    });
    assert.deepEqual(require('../package.json').dependencies, {'@openhilo/itt-contracts':'0.1.0'});
});
test('custom application round-trips independently of its input object', () => {
    const input = {
        version: 1,
        id: 'lab',
        title: 'Lab',
        classFacet: {tag: 'stage', values: [{value: 'review', label: 'Review', tone: 'green'}]},
        tags: {state: {inlineEditable: true}}
    };
    const parsed = parseStudioApplication(input);
    parsed.classFacet.values[0].label = 'changed';
    assert.equal(input.classFacet.values[0].label, 'Review');
});
test('invalid wire descriptors and duplicate facets fail explicitly', () => {
    for (const value of [null, [], {...GENERIC_STUDIO_APPLICATION, version: 2},
        {...GENERIC_STUDIO_APPLICATION, tags: {state: {tone: 'arbitrary-css'}}},
        {...GENERIC_STUDIO_APPLICATION, tags: {state: {inlineEditable: 'true'}}},
        {...GENERIC_STUDIO_APPLICATION, classFilterTags: [1]},
        {
            ...GENERIC_STUDIO_APPLICATION,
            classFacet: {tag: 'stage', values: [{value: 'x', label: 'X'}, {value: 'x', label: 'Other'}]}
        },
    ]) assert.throws(() => parseStudioApplication(value), /Invalid Studio/);
});

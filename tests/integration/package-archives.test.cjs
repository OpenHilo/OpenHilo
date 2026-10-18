const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function verify(manifest, files) {
    const script = path.resolve(__dirname, '../../scripts/check-packages.cjs');
    assert.ok(fs.existsSync(script), 'standalone archive checker must exist');
    return require(script).checkPackageContents(manifest, new Set(files));
}

const manifest = {
    name: '@openhilo/example',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    exports: {
        '.': {require: './dist/index.js', types: './dist/index.d.ts'},
        './helper': {default: './dist/helper.js', types: './dist/helper.d.ts'}
    },
    typesVersions: {'*': {helper: ['dist/helper.d.ts']}},
    bin: {'openhilo-example': 'dist/cli.js'}
};
const files = ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'package.json', 'dist/index.js', 'dist/index.d.ts', 'dist/helper.js', 'dist/helper.d.ts', 'dist/cli.js'];
test('archive check accepts complete declared public files', () => assert.doesNotThrow(() => verify(manifest, files)));
for (const missing of ['dist/helper.js', 'dist/helper.d.ts', 'dist/cli.js', 'LICENSE']) test(`archive check rejects missing ${missing}`, () => assert.throws(() => verify(manifest, files.filter(f => f !== missing)), /archive missing/));
test('typesVersions only entries are required too', () => assert.throws(() => verify({
    ...manifest,
    typesVersions: {'*': {hidden: ['dist/hidden.d.ts']}}
}, files), /archive missing dist\/hidden/));
test('Python runner and ESM package markers are runtime assets', () => {
    assert.throws(() => verify({
        ...manifest,
        name: '@openhilo/code-local'
    }, files), /archive missing dist\/_itt_runner.py/);
    const esm = {...manifest, exports: {'.': {import: './dist/esm/index.js', require: './dist/index.js'}}};
    assert.throws(() => verify(esm, [...files, 'dist/esm/index.js']), /archive missing dist\/esm\/package.json/);
});
test('undeclared credential or node_modules files cannot enter archives', () => {
    for (const file of ['.env.production', 'node_modules/leak.js', '.git/config']) assert.throws(() => verify(manifest, [...files, file]), /unintended archive entry/);
});

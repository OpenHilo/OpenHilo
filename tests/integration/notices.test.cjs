const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {generate} = require('../../scripts/lib/third-party.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-notices-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));

    function write(name, value) {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    }

    const pkg = {
        name: '@openhilo/example',
        version: '0.1.0',
        dependencies: {external: '1.0.0'},
        peerDependencies: {react: '^19.0.0'},
        peerDependenciesMeta: {react: {optional: true}}
    };
    write('package.json', {name: 'candidate', workspaces: ['packages/example']});
    write('packages/example/package.json', pkg);
    write('package-lock.json', {
        packages: {
            '': {},
            'packages/example': pkg,
            'node_modules/external': {version: '1.0.0', license: 'MIT', integrity: 'fixture-integrity'}
        }
    });
    write('node_modules/external/package.json', {name: 'external', version: '1.0.0', license: 'MIT'});
    write('node_modules/external/LICENSE', 'Copyright original owner\r\nPermission retained.\r\n');
    return {root, write};
}

test('notices use only the standalone lock and preserve exact upstream license text', t => {
    const {root} = fixture(t);
    const output = generate(root);
    const inventory = JSON.parse(output.get('docs/third-party-inventory.json'));
    assert.deepEqual(inventory.locks.map(l => l.path), ['package-lock.json']);
    assert.deepEqual(inventory.locks[0].absentOptional, [{from: 'packages/example', name: 'react'}]);
    assert.match(output.get('packages/example/THIRD_PARTY_NOTICES.txt'), /Copyright original owner\r\nPermission retained\.\r\n/);
    assert.doesNotMatch(output.get('THIRD_PARTY_NOTICES.txt'), /Studio|Both lockfiles|IntentOrch/);
});
test('missing or version-mismatched license sources fail instead of inventing attributions', t => {
    const {root, write} = fixture(t);
    fs.unlinkSync(path.join(root, 'node_modules/external/LICENSE'));
    assert.throws(() => generate(root), /no license text/);
    write('node_modules/external/LICENSE', 'original');
    write('node_modules/external/package.json', {name: 'external', version: '2.0.0'});
    assert.throws(() => generate(root), /installed version differs/);
});
test('dependency metadata drift is detected before generating apparently fresh notices', t => {
    const {root, write} = fixture(t);
    write('packages/example/package.json', {name: '@openhilo/example', version: '0.1.0', dependencies: {missing: '1'}});
    assert.throws(() => generate(root), /differs from lock/);
});

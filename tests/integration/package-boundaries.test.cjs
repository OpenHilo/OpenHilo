const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function checker() {
    const filename = path.resolve(__dirname, '../../scripts/check-boundaries.cjs');
    assert.ok(fs.existsSync(filename), 'standalone boundary checker must exist');
    return require(filename).checkBoundaries;
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-boundaries-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const create = (name, code = '', dependencies = {}, extra = {}) => {
        const dir = path.join(root, 'packages', name);
        fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            name: '@openhilo/' + name,
            exports: {'.': './src/index.ts'},
            dependencies, ...extra
        }));
        fs.writeFileSync(path.join(dir, 'src/index.ts'), code);
        return dir;
    };
    return {root, create, errors: () => checker()(root).errors.join('\n')};
}

test('all twelve built core packages have valid boundaries without platform directories', () => {
    const result = checker()(path.resolve(__dirname, '../..'));
    assert.equal(result.packages, 12);
    assert.deepEqual(result.errors, []);
});
test('public entries and declared builtins work without executing source', t => {
    const f = fixture(t);
    f.create('itt-contracts');
    const dir = f.create('compiler', "import fs from 'node:fs'; import '@openhilo/itt-contracts'; import './helper.js'; throw Error('never execute');", {'@openhilo/itt-contracts': '0.1.0'});
    fs.writeFileSync(path.join(dir, 'src/helper.ts'), 'export const n=1');
    assert.equal(f.errors(), '');
});
test('unknown dependencies and workspace-private imports are rejected', t => {
    const f = fixture(t);
    f.create('itt-contracts');
    f.create('compiler', "import ts from 'typescript'; import '@openhilo/itt-contracts/src/private';", {'@openhilo/itt-contracts': '0.1.0'}, {devDependencies: {typescript: '5.9.3'}});
    assert.match(f.errors(), /undeclared dependency typescript/);
    assert.match(f.errors(), /non-public package entry/);
});
test('platform dependencies cannot be smuggled in as optional peers or type imports', t => {
    const f = fixture(t);
    f.create('runtime', "export type X = import('@openhilo/platform-services').X;", {}, {peerDependencies: {'@openhilo/platform-services': '0.1.0'}});
    assert.match(f.errors(), /forbidden dependency direction/);
    assert.match(f.errors(), /unknown workspace/);
});
test('relative and symlink escapes and dynamic loads fail closed', t => {
    const f = fixture(t), target = f.create('itt-contracts'),
        compiler = f.create('compiler', "import '../../itt-contracts/src/index';");
    assert.match(f.errors(), /import escapes/);
    fs.writeFileSync(path.join(compiler, 'src/index.ts'), "import './linked';");
    fs.symlinkSync(path.join(target, 'src/index.ts'), path.join(compiler, 'src/linked.ts'));
    assert.match(f.errors(), /symlink/);
    fs.unlinkSync(path.join(compiler, 'src/linked.ts'));
    fs.writeFileSync(path.join(compiler, 'src/index.ts'), 'const name="dynamic"; require(name);');
    assert.match(f.errors(), /unapproved dynamic/);
});
test('all conditional export files and declaration dependencies are checked', t => {
    const f = fixture(t);
    f.create('itt-contracts');
    const dir = f.create('compiler', '', {'@openhilo/itt-contracts': '0.1.0'}, {
        exports: {
            '.': {
                types: './public/index.d.ts',
                require: './src/index.ts'
            }
        }
    });
    assert.match(f.errors(), /missing built public entry/);
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public/index.d.ts'), "export type X = import('@openhilo/private').X;");
    assert.match(f.errors(), /public\/index.d.ts:1: forbidden dependency/);
});
test('workspace cycles are diagnosed even when both directions are declared', t => {
    const f = fixture(t);
    f.create('runtime', '', {'@openhilo/itt-contracts': '0.1.0'});
    f.create('itt-contracts', '', {'@openhilo/runtime': '0.1.0'});
    assert.match(f.errors(), /workspace dependency cycle/);
});

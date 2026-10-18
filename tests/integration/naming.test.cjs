const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const manifest = require('../../package.json');

test('all public package names and dependency names resolve in the OpenHilo scope', () => {
    const lock = require('../../package-lock.json');
    for (const dir of manifest.workspaces) {
        const pkg = require(path.join(root, dir, 'package.json'));
        assert.match(pkg.name, /^@openhilo\//, dir);
        assert.ok(require.resolve(pkg.name).startsWith(path.join(root, dir)), pkg.name);
        assert.equal(lock.packages[dir].name, pkg.name);
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
            for (const name of Object.keys(pkg[field] ?? {})) assert.ok(!name.startsWith('@intentorch/'), `${pkg.name}: ${name}`);
        }
    }
    assert.ok(!Object.keys(lock.packages).some(p => p.startsWith('node_modules/@intentorch/')));
});

test('public compiler CLI name has working help and preserves input/diagnostic exit codes', t => {
    const bin = require('../../packages/compiler/package.json').bin;
    assert.equal(bin['openhilo-compile'], 'dist/cli.js');
    assert.equal(bin['intentorch-compile'], undefined);
    const cli = path.join(root, 'packages/compiler', bin['openhilo-compile']);
    const invoke = args => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
    const help = invoke(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stderr, /openhilo-compile/);
    assert.equal(invoke([]).status, 2);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo naming '));
    t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
    const input = path.join(temp, 'program.json');
    fs.writeFileSync(input, '{');
    assert.equal(invoke([input]).status, 2);
    fs.writeFileSync(input, JSON.stringify({
        files: {'main.ts': 'export async function main(): Promise<{ answer: number }> { return { answer: 42 }; }'},
        entries: [{file: 'main.ts', exportName: 'main'}]
    }));
    const success = invoke([input]);
    assert.equal(success.status, 0, success.stderr);
    const result = JSON.parse(success.stdout);
    assert.equal(result.ok, true);
    assert.ok(result.artifacts[0].implementation);
    fs.writeFileSync(input, JSON.stringify({
        files: {'main.ts': 'export async function main() { await not_declared(); }'},
        entries: [{file: 'main.ts', exportName: 'main'}]
    }));
    assert.equal(invoke([input]).status, 1);
});

test('renamed public API still validates pre-rename ITT v2 graphs and file references', () => {
    const {IttValidator, isFileRef} = require('@openhilo/itt-contracts');
    const prior = {
        version: '2.0',
        entry: 'done',
        inputs: {},
        outputs: {answer: 'answer'},
        nodes: {done: {id: 'done', type: 'assign', assignments: [{var: 'answer', expr: '42'}], next: 'END'}}
    };
    assert.deepEqual(new IttValidator().validate(prior).errors, []);
    assert.equal(isFileRef({type: 'file_ref', path: 'report.md', hash: 'sha256:original', mtime: 1}), true);
});

test('workspace source contains no old brand identifiers outside copyright attribution', () => {
    const compatibilityFile = path.join(root, 'docs/naming-compatibility.json');
    assert.ok(fs.existsSync(compatibilityFile), 'compatibility inventory must be explicit');
    const inventory = JSON.parse(fs.readFileSync(compatibilityFile));
    assert.deepEqual(inventory, [], 'no old runtime identifier exceptions remain');

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (entry.name === 'dist' || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (entry.name === 'LICENSE' || entry.name === 'THIRD_PARTY_NOTICES.txt') continue;
            const rel = path.relative(root, full).split(path.sep).join('/');
            for (const token of fs.readFileSync(full, 'utf8').match(/intentorch(?:[._/-][a-z0-9_-]+)*/ig) ?? []) {
                assert.ok(inventory.some(item => item.paths.includes(rel) && new RegExp(item.pattern).test(token)), `${rel}: undocumented ${token}`);
            }
        }
    }

    for (const dir of manifest.workspaces) walk(path.join(root, dir));
});

test('old default AI executor references reject before creating execution or provider calls', async () => {
    const {pathToFileURL} = require('node:url');
    const {CodexTaskExecutor} = require('@openhilo/ai-codex');
    const {SdkTaskExecutor} = require('@openhilo/ai-sdk');
    const {LegacyJsonCompletionExecutor} = require('@openhilo/ai-sdk/legacy-json-executor');
    const codex = new CodexTaskExecutor({cliPath: '/nonexistent/no-provider-must-start'});
    const sdk = new SdkTaskExecutor({
        profiles: {test: {provider: 'openai', model: 'fixture-model', client: {}}},
        defaultProfile: 'test'
    });
    const legacy = new LegacyJsonCompletionExecutor({
        base_url: 'http://offline.invalid',
        api_key: 'fixture-key',
        model: 'fixture-model'
    });
    assert.equal(codex.id, 'openhilo.codex');
    assert.equal(sdk.id, 'openhilo.ai-sdk');
    assert.equal(legacy.id, 'openhilo.legacy-json-completion');
    const events = [];
    const host = {
        attemptId: 'rename-check', signal: new AbortController().signal,
        workspace: {id: 'fixture', uri: pathToFileURL(root).href}, onEvent: event => events.push(event)
    };
    for (const [executor, oldId] of [[codex, 'intentorch.codex'], [sdk, 'intentorch.ai-sdk'], [legacy, 'intentorch.legacy-json-completion']]) {
        await assert.rejects(executor.start({
            version: 1, taskId: 'old-reference', instruction: 'Never execute',
            inputs: {}, output: {answer: 'text'}, requiredCapabilities: [],
            continuation: {executorId: oldId, version: 1, opaqueId: 'prior-session', workspaceId: 'fixture'},
        }, host), /Session belongs to another executor/);
    }
    assert.deepEqual(events, []);
});

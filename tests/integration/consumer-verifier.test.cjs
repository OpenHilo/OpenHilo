const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {dependencyClosure, assertIsolation} = require('../../scripts/verify-consumers.cjs');
test('consumer closures include only selected roots and transitive public package requirements', () => {
    const manifests = new Map([['@openhilo/a', {
        dependencies: {
            '@openhilo/b': '0.1.0',
            outside: '1'
        }
    }], ['@openhilo/b', {dependencies: {}}], ['@openhilo/unrelated', {}]]);
    assert.deepEqual(dependencyClosure(['@openhilo/a'], manifests), ['@openhilo/a', '@openhilo/b']);
    assert.throws(() => dependencyClosure(['@openhilo/missing'], manifests), /missing/i);
    manifests.get('@openhilo/b').dependencies = {'@openhilo/absent': '0.1.0'};
    assert.throws(() => dependencyClosure(['@openhilo/a'], manifests), /absent/);
});
test('consumer verification rejects source symlinks and extra core packages', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-isolation-test-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const scope = path.join(dir, 'node_modules/@openhilo');
    fs.mkdirSync(scope, {recursive: true});
    fs.mkdirSync(path.join(scope, 'one'));
    assertIsolation(dir, ['@openhilo/one']);
    fs.mkdirSync(path.join(scope, 'extra'));
    assert.throws(() => assertIsolation(dir, ['@openhilo/one']), /closure/);
    fs.rmSync(path.join(scope, 'extra'), {recursive: true});
    fs.rmSync(path.join(scope, 'one'), {recursive: true});
    fs.symlinkSync(dir, path.join(scope, 'one'), 'dir');
    assert.throws(() => assertIsolation(dir, ['@openhilo/one']), /symlink/);
});
test('source archives without Git metadata remain verifiable', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-source-archive-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const {readSourceCommit} = require('../../scripts/verify-consumers.cjs');
    assert.equal(readSourceCommit(dir), null);
});

// This regression runs the real consumer and adapter. A non-executable peer
// catches a return to OS/shebang execution without relying on a timing race.
function codexConsumer(t, peer) {
    const {spawnSync} = require('node:child_process');
    const root = path.resolve(__dirname, '../..');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo cold consumer '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'fixtures'));
    const startup = "require('node:fs').appendFileSync('peer-starts.jsonl', JSON.stringify({pid:process.pid})+'\\n');\n";
    const script = peer ?? fs.readFileSync(path.join(root, 'adapters/ai-codex/test/fixtures/codex.cjs'), 'utf8').replace(/^#![^\n]*\n/, '');
    fs.writeFileSync(path.join(dir, 'fixtures/codex.cjs'), startup + script, {mode: 0o444});
    const result = spawnSync(process.execPath, [path.join(root, 'tests/consumers/codex.cjs')], {
        cwd: dir, encoding: 'utf8', timeout: 10000,
        env: {
            ...process.env,
            OPENAI_API_KEY: '',
            ANTHROPIC_API_KEY: '',
            NODE_OPTIONS: `--require=${JSON.stringify(path.join(root, 'scripts/offline-guard.cjs'))}`
        },
    });
    const record = path.join(dir, 'workspace/peer-starts.jsonl');
    return {
        result,
        starts: fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse) : []
    };
}

test('Codex archive consumer reads a non-executable peer through Node exactly once', t => {
    const {result, starts} = codexConsumer(t);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(starts.length, 1, 'The consumer must not retry the protocol peer');
});
test('Codex archive consumer preserves malformed-protocol failure without retrying', t => {
    const {result, starts} = codexConsumer(t, "process.stdout.write('not json\\n');process.stdin.resume();");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Invalid Codex protocol message/);
    assert.equal(starts.length, 1);
    assert.throws(() => process.kill(starts[0].pid, 0), {code: 'ESRCH'});
});
test('Codex archive consumer still times out and cleans up an unresponsive peer', t => {
    const {result, starts} = codexConsumer(t, 'process.stdin.resume();');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /"code":"timeout"/);
    assert.match(result.stderr, /"phase":"stopping"/);
    assert.equal(starts.length, 1);
    assert.throws(() => process.kill(starts[0].pid, 0), {code: 'ESRCH'});
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

test('example preflight reports CLI versions without restricting their release series', t => {
    let version = '', calls = 0;
    t.mock.method(childProcess, 'spawnSync', (command, args) => {
        assert.equal(command, 'codex');
        assert.deepEqual(args, ['--version']);
        calls++;
        return {status: 0, stdout: version + '\n'};
    });
    const file = require.resolve('../../examples/lib/resources.cjs');
    delete require.cache[file];
    t.after(() => {
        delete require.cache[file];
    });
    const {checkProvider} = require(file);
    for (version of ['codex-cli 0.159.0', 'codex-cli 0.161.0', 'codex-cli 1.0.0', 'custom build']) assert.equal(checkProvider('codex'), version);
    assert.equal(calls, 4);
    assert.equal(checkProvider('offline'), null);
    assert.equal(calls, 4);
});

test('example preflight still rejects an unavailable CLI', t => {
    t.mock.method(childProcess, 'spawnSync', () => ({status: null, error: new Error('ENOENT')}));
    const file = require.resolve('../../examples/lib/resources.cjs');
    delete require.cache[file];
    t.after(() => {
        delete require.cache[file];
    });
    assert.throws(() => require(file).checkProvider('codex'), /Codex CLI is unavailable/);
});

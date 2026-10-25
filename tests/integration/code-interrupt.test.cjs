const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');

test('example host forwards foreground SIGINT to Code and finishes cleanup', {timeout: 10000, skip: process.platform === 'win32'}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-interrupt-'));
    const child = spawn(process.execPath, [path.join(__dirname, '../fixtures/code-interrupt.cjs'), root], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => {output += data;});
    child.stderr.on('data', data => {output += data;});
    const ended = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({code, signal}));
    });
    t.after(() => {
        try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
        fs.rmSync(root, {recursive: true, force: true});
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(root, 'ready'))) {
        assert.ok(Date.now() < deadline && child.exitCode === null, output || 'Code did not become ready');
        await delay(10);
    }
    process.kill(-child.pid, 'SIGINT');
    assert.deepEqual(await ended, {code: 0, signal: null}, output);
    const result = JSON.parse(output.split('RESULT:')[1]);
    assert.equal(result.status, 'aborted', output);
    assert.equal(fs.existsSync(path.join(root, 'effect')), false);
    assert.equal(result.lockExists, false);
    assert.equal(result.sigintListeners, 0);
});

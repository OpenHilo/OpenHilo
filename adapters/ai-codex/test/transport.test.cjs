const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {CodexTransport} = require('../dist/transport');

const peer = path.join(__dirname, 'fixtures/transport-peer.cjs');
const posix = process.platform !== 'win32';
fs.chmodSync(peer, 0o755);

function setup(t, mode, extraEnv = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transport-'));
    const failures = [];
    const transport = new CodexTransport(peer, dir, {...process.env, PEER_MODE: mode, ...extraEnv}, () => undefined,
        error => failures.push(error.message));
    t.after(async () => {
        await transport.close();
        for (const file of ['escaped.pid']) {
            const pidFile = path.join(dir, file);
            if (fs.existsSync(pidFile)) try {process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');} catch {}
        }
        fs.rmSync(dir, {recursive: true, force: true});
    });
    return {dir, transport, failures};
}
// Exited orphans remain zombies until reaped; Linux still accepts kill(-pgid, 0) for them.
function groupAlive(pgid) {
    try {
        process.kill(-pgid, 0);
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
    }
    if (process.platform !== 'linux') return true;
    return fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).some(entry => {
        let stat;
        try {stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');} catch {return false;}
        const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return Number(pgrp) === pgid && state !== 'Z' && state !== 'X';
    });
}
async function untilFile(file) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file)) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
        await delay(10);
    }
}
async function untilGroupGone(pgid) {
    const deadline = Date.now() + 3000;
    while (groupAlive(pgid)) {
        if (Date.now() > deadline) {
            process.kill(-pgid, 'SIGKILL');
            assert.fail(`process group ${pgid} survived`);
        }
        await delay(20);
    }
}

test('close escalates to group SIGKILL even after the main process exits on SIGTERM', {skip: !posix, timeout: 10000}, async t => {
    const s = setup(t, 'exit-on-term', {PEER_PGID_FILE: path.join(os.tmpdir(), `codex-pgid-${process.pid}-1`)});
    const pgidFile = path.join(os.tmpdir(), `codex-pgid-${process.pid}-1`);
    t.after(() => fs.rmSync(pgidFile, {force: true}));
    assert.deepEqual(await s.transport.request('ping', {}), {ok: true});
    await untilFile(pgidFile);
    const pgid = Number(fs.readFileSync(pgidFile, 'utf8'));
    await s.transport.close();
    assert.equal(groupAlive(pgid), false);
});

test('close does not hang when an escaped descendant holds the stdio pipes', {skip: !posix, timeout: 10000}, async t => {
    const s = setup(t, 'hold-pipes');
    assert.deepEqual(await s.transport.request('ping', {}), {ok: true});
    await untilFile(path.join(s.dir, 'escaped.pid'));
    const started = Date.now();
    await s.transport.close();
    assert.ok(Date.now() - started < 3000);
});

test('frame limit counts bytes and stops buffering once exceeded', {timeout: 10000}, async t => {
    const s = setup(t, 'multibyte-limit');
    await assert.rejects(s.transport.request('big', {}), /exceeded 4 MiB/);
    const flood = setup(t, 'flood');
    await assert.rejects(flood.transport.request('flood', {}), /exceeded 4 MiB/);
    await delay(200);
    assert.equal(flood.transport.bufferedBytes, 0);
    assert.deepEqual(flood.transport.chunks, []);
    assert.deepEqual(flood.failures, ['Codex protocol frame exceeded 4 MiB']);
});

test('replies with string JSON-RPC ids settle their requests', {timeout: 10000}, async t => {
    const s = setup(t, 'string-id');
    assert.deepEqual(await s.transport.request('first', {}, 2000), {ok: true, id: '1'});
    assert.deepEqual(await s.transport.request('second', {}, 2000), {ok: true, id: '2'});
    assert.deepEqual(s.failures, []);
});

test('an uncorrelated null-id error fails pending requests instead of waiting for the timeout', {timeout: 10000}, async t => {
    const s = setup(t, 'null-id-error');
    const started = Date.now();
    await assert.rejects(s.transport.request('ping', {}, 5000), /unreadable request \(-32700\)/);
    assert.ok(Date.now() - started < 2000);
});

for (const [name, trigger, expected] of [
    ['SIGINT', child => child.kill('SIGINT'), {signal: 'SIGINT'}],
    ['process.exit', child => child.stdin.end('exit'), {code: 3}],
]) test(`host ${name} stops the Codex process group`, {skip: !posix, timeout: 10000}, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-host-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const pgidFile = path.join(dir, 'pgid');
    const host = `
        const {CodexTransport} = require(${JSON.stringify(require.resolve('../dist/transport'))});
        new CodexTransport(${JSON.stringify(peer)}, ${JSON.stringify(dir)}, {...process.env, PEER_MODE: 'normal', PEER_PGID_FILE: ${JSON.stringify(pgidFile)}}, () => {}, () => {});
        process.stdin.on('data', () => process.exit(3));`;
    const child = spawn(process.execPath, ['-e', host], {stdio: ['pipe', 'inherit', 'inherit']});
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
    await untilFile(pgidFile);
    const pgid = Number(fs.readFileSync(pgidFile, 'utf8'));
    await delay(50);
    trigger(child);
    const result = await exited;
    if (expected.signal) assert.equal(result.signal, expected.signal);
    else assert.equal(result.code, expected.code);
    await untilGroupGone(pgid);
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const run = path.join(root, 'examples/model-routing/run.cjs'),
    resume = path.join(root, 'examples/model-routing/resume.cjs');

// The shared protocol peer never calls a model; only its default result is
// adapted to this workflow's `{text}` output declaration.
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo routing '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const source = fs.readFileSync(path.join(root, 'adapters/ai-codex/test/fixtures/codex.cjs'), 'utf8');
    const peer = source.replace(/function finish\(outputs = \{[^\n]*\}\)/, "function finish(outputs = {text: 'FIXTURE ' + scenario.slice(0, 24)})");
    assert.notEqual(peer, source, 'the protocol peer default result must be adapted');
    fs.writeFileSync(path.join(dir, 'peer.cjs'), peer, {mode: 0o755});
    const level = effort => ({adapter: 'codex', cli_path: path.join(dir, 'peer.cjs'), effort, sandbox: 'read-only', timeout_ms: 10000});
    const config = {
        adapter: 'routed', routes: {
            default: {defaultLevel: 'medium', levels: {medium: level('low')}},
            coding: {defaultLevel: 'pro', levels: {pro: level('medium')}}
        }
    };
    fs.writeFileSync(path.join(dir, 'ai.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(dir, 'changed.json'), JSON.stringify({...config, routes: {...config.routes, coding: {defaultLevel: 'pro', levels: {pro: level('high')}}}}));
    return {dir, config: path.join(dir, 'ai.json'), changed: path.join(dir, 'changed.json'), output: path.join(dir, 'nested parent/output')};
}

const node = args => spawnSync(process.execPath, args, {encoding: 'utf8', timeout: 20000});
const runDir = result => {
    const match = result.stdout.match(/"runDir": "(.+)"/);
    assert.ok(match, result.stdout + result.stderr);
    return match[1];
};
const aiCalls = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.event === 'node_pending' && e.executor === 'ai').length;

test('model routing pauses with the text to decide on and resumes in new processes with the same configuration', t => {
    const f = fixture(t);
    const first = node([run, '--output', f.output, '--config', f.config]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const dir = runDir(first);
    assert.match(first.stdout, /"status": "suspended"/);
    assert.match(first.stdout, /Continue with one short implementation suggestion\?/);
    assert.match(first.stdout, /text: FIXTURE Summarize this topic/);
    assert.match(first.stdout, /--run-dir ".+" --continue true\|false/);
    assert.equal(aiCalls(dir), 1);

    const before = fs.readFileSync(path.join(dir, 'execution.jsonl'));
    const changed = node([resume, '--run-dir', dir, '--continue', 'true', '--config', f.changed]);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /routing configuration changed/i);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'execution.jsonl')), before);

    const second = node([resume, '--run-dir', dir, '--continue', 'true', '--config', f.config]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /text: FIXTURE Give one short practical/);
    assert.equal(aiCalls(dir), 2);

    const done = node([resume, '--run-dir', dir, '--continue', 'false', '--config', f.config]);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /"status": "completed"/);
    assert.match(done.stdout, /"text": "FIXTURE Give one short practical/);
    assert.equal(aiCalls(dir), 2);
});

test('model routing reports unusable directories and a missing CLI clearly', t => {
    const f = fixture(t);
    const first = node([run, '--output', f.output, '--config', f.config]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const reused = node([run, '--output', f.output, '--config', f.config]);
    assert.equal(reused.status, 1);
    assert.match(reused.stderr, /Output already exists; choose a new directory/);
    const topLevel = node([resume, '--run-dir', f.output, '--continue', 'false', '--config', f.config]);
    assert.equal(topLevel.status, 1);
    assert.match(topLevel.stderr, /complete printed Records path/);

    const missing = JSON.parse(fs.readFileSync(f.config, 'utf8'));
    missing.routes.default.levels.medium.cli_path = path.join(f.dir, 'no-such-codex');
    fs.writeFileSync(f.config, JSON.stringify(missing));
    const failed = node([run, '--output', path.join(f.dir, 'missing-cli'), '--config', f.config]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /"status": "failed"/);
    assert.match(failed.stderr, /Run stopped: .*Codex CLI/);
});

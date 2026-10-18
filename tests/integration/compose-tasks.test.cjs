const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function launch(t, answer, provider = 'offline') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo compose '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const output = path.join(dir, 'result');
    const result = spawnSync(process.execPath, [path.join(root, 'examples/compose-tasks/run.cjs'), '--provider', provider, '--input', path.join(root, 'examples/compose-tasks/input.sample.json'), '--output', output], {input: answer, encoding: 'utf8', timeout: 15000});
    return {output, result};
}
test('compose tasks passes Human requirements through AI and saves the Code result', t => {
    const {output, result} = launch(t, 'Focus on the release date\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const text = fs.readFileSync(path.join(output, 'summary.md'), 'utf8');
    assert.match(text, /Focus on the release date/);
    assert.match(text, /Thursday/);
    assert.match(text, /OFFLINE/);
    const runDir = result.stdout.match(/Records: (.+)\n/)[1];
    const events = fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e => e.event === 'node_success' && e.outputs?.focus === 'Focus on the release date'));
    assert.ok(events.some(e => e.event === 'node_pending' && e.executor === 'ai'));
    assert.ok(events.some(e => e.event === 'node_pending' && e.executor === 'code'));
});
test('compose tasks EOF is not a Human answer and starts no AI or Code work', t => {
    const {output, result} = launch(t, '');
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(output, 'summary.md')), false);
    assert.doesNotMatch(result.stdout, /Running ai:|Running code:/);
});
test('compose tasks rejects unsupported providers before making output', t => {
    const {output, result} = launch(t, 'Focus\n', 'unknown');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Choose --provider/);
    assert.equal(fs.existsSync(output), false);
});

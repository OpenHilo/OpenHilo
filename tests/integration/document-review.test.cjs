const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const fixtureScript = path.join(__dirname, '../fixtures/document-review.cjs');

function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo document '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const input = path.join(dir, 'original brief.md');
    fs.writeFileSync(input, 'Include the river otter in the welcome note.\n');
    return {dir, input, output: path.join(dir, 'output with spaces')};
}

function launch(args, input = '', mode = '') {
    return spawnSync(process.execPath, [fixtureScript, ...args], {
        input, encoding: 'utf8', timeout: 20000,
        env: {...process.env, DOCUMENT_FIXTURE_MODE: mode}
    });
}

function records(result) {
    const m = result.stdout.match(/Records: (.+)\n/);
    assert.ok(m, result.stdout + result.stderr);
    return m[1];
}

function attempts(runDir) {
    return fs.readFileSync(path.join(runDir, 'ai-attempts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function events(runDir) {
    return fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function status(r, expected) {
    assert.equal(r.status, expected, r.stdout + r.stderr);
}

test('document example passes actual files between AI, Code and Human across three processes without replay', t => {
    const f = setup(t), original = fs.readFileSync(f.input);
    const first = launch(['start', f.input, f.output, 'defer']);
    status(first, 2);
    const runDir = records(first), draft = path.join(f.output, 'workspace/draft.md'),
        old = fs.readFileSync(draft, 'utf8');
    assert.match(old, /river otter/);
    assert.match(old, /Cedar Room/);
    assert.match(first.stdout, /document already exists/);
    assert.doesNotMatch(first.stdout, /No report was saved/);
    const initialAttempt = attempts(runDir)[0];
    assert.deepEqual(initialAttempt.inputs, {brief: 'brief.md', references: 'references'});
    assert.ok(events(runDir).some(e => e.event === 'node_success' && e.outputs?.document?.type === 'file_ref'));
    // Recovery must use the stored source snapshot, not recompile the example artifacts.
    fs.rmSync(path.join(f.output, 'artifacts'), {recursive: true});
    const second = launch(['resume', runDir], '2\nAdd a quiet reading corner.\n');
    status(second, 2);
    assert.match(second.stdout, /# Draft/);
    assert.match(second.stdout, /Add a quiet reading corner/);
    assert.equal(records(second), runDir);
    assert.notEqual(fs.readFileSync(draft, 'utf8'), old);
    const revisedAttempts = attempts(runDir);
    assert.equal(revisedAttempts.length, 2);
    assert.deepEqual(revisedAttempts[0], initialAttempt);
    assert.equal(revisedAttempts[1].inputs.document, 'draft.md');
    assert.equal(revisedAttempts[1].inputs.references, 'references');
    assert.equal(revisedAttempts[1].inputs.feedback, 'Add a quiet reading corner.');
    const third = launch(['resume', runDir], '1\n\n');
    status(third, 0);
    assert.equal(attempts(runDir).length, 2);
    assert.match(third.stdout, /Verified \d+ bytes; 1 revision/);
    const output = events(runDir).find(e => e.event === 'run_complete').outputs;
    assert.equal(output.finished, true);
    assert.equal(output.document, 'draft.md');
    assert.equal(output.bytes, fs.statSync(draft).size);
    assert.deepEqual(fs.readFileSync(f.input), original);
    assert.deepEqual(fs.readFileSync(path.join(f.output, 'workspace/brief.md')), original);
});
test('document example: first-review completion makes only one AI call; invalid choice reprompts', t => {
    const f = setup(t), r = launch(['start', f.input, f.output], 'wrong\n1\n\n');
    status(r, 0);
    assert.match(r.stdout, /Choose one of the listed numbers/);
    assert.equal(attempts(records(r)).length, 1);
});
test('document example: EOF retains the request; repeated EOF never reruns the draft', t => {
    const f = setup(t), r = launch(['start', f.input, f.output]);
    status(r, 2);
    const dir = records(r);
    status(launch(['resume', dir]), 2);
    assert.equal(attempts(dir).length, 1);
});
test('document example bounds revisions and retains the unfinished file', t => {
    const f = setup(t),
        r = launch(['start', f.input, f.output], '2\nFirst change\n2\nSecond change\n2\nThird change\n');
    status(r, 2);
    assert.match(r.stdout, /Revision limit reached/);
    assert.equal(attempts(records(r)).length, 3);
    assert.ok(fs.existsSync(path.join(f.output, 'workspace/draft.md')));
});
for (const mode of ['missing-file', 'outside-path', 'empty-file']) test(`document example rejects ${mode} without a successful review`, t => {
    const f = setup(t), r = launch(['start', f.input, f.output], '1\n\n', mode);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Finished reviewed document/);
});
test('document example rejects a revision that returns a different file', t => {
    const f = setup(t), r = launch(['start', f.input, f.output], '2\nChange the title\n', 'different-path');
    status(r, 2);
    assert.match(r.stdout, /different document path/);
    assert.equal(attempts(records(r)).length, 2);
});
for (const action of ['change', 'delete']) test(`document example detects document ${action} while Human is paused`, t => {
    const f = setup(t), first = launch(['start', f.input, f.output, 'defer']);
    status(first, 2);
    const file = path.join(f.output, 'workspace/draft.md');
    if (action === 'change') fs.appendFileSync(file, 'Unexpected external edit'); else fs.unlinkSync(file);
    const r = launch(['resume', records(first)], '1\n\n');
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Finished reviewed document/);
    assert.equal(attempts(records(first)).length, 1);
});
test('document example rejects bad inputs and an occupied output directory before starting AI', t => {
    const f = setup(t);
    for (const content of [Buffer.from('  '), Buffer.from([255]), Buffer.alloc(65537, 97)]) {
        fs.writeFileSync(f.input, content);
        const r = launch(['start', f.input, f.output]);
        status(r, 1);
        assert.equal(fs.existsSync(f.output), false);
    }
    fs.writeFileSync(f.input, 'A brief');
    fs.mkdirSync(f.output);
    fs.writeFileSync(path.join(f.output, 'keep.txt'), 'keep');
    status(launch(['start', f.input, f.output]), 1);
    assert.equal(fs.readFileSync(path.join(f.output, 'keep.txt'), 'utf8'), 'keep');
});
test('document resume refuses a mismatched receipt without adding events or AI calls', t => {
    const f = setup(t), first = launch(['start', f.input, f.output, 'defer']);
    status(first, 2);
    const runDir = records(first), recordFile = path.join(runDir, 'run.json'),
        record = JSON.parse(fs.readFileSync(recordFile));
    const before = events(runDir);
    fs.writeFileSync(recordFile, JSON.stringify({...record, example: 'another-example'}));
    status(launch(['resume', runDir], '1\n\n'), 1);
    assert.deepEqual(events(runDir), before);
    assert.equal(attempts(runDir).length, 1);
});

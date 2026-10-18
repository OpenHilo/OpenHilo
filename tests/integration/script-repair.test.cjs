const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(__dirname, '../fixtures/script-repair.cjs');
const sample = path.join(root, 'examples/script-repair/sample');
const correct = 'def average(values):\n    if not values:\n        raise ValueError("empty")\n    return sum(values) / len(values)\n';

function setup(t, source = fs.readFileSync(path.join(sample, 'calculator.py'))) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo script repair '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const input = path.join(dir, 'original.py');
    fs.writeFileSync(input, source);
    return {dir, input, output: path.join(dir, 'output with spaces')};
}

function run(f, mode = '') {
    return spawnSync(process.execPath, [fixture, f.input, f.output], {
        input: '', encoding: 'utf8', timeout: 30000,
        env: {...process.env, SCRIPT_FIXTURE_MODE: mode}
    });
}

function inspect(r) {
    const match = r.stdout.match(/Records: (.+)\n/);
    assert.ok(match, r.stdout + r.stderr);
    const dir = match[1], attemptsFile = path.join(dir, 'ai-attempts.jsonl');
    const events = fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const attempts = fs.existsSync(attemptsFile) ? fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
    const tests = events.filter(e => e.event === 'node_success' && Object.hasOwn(e.outputs ?? {}, 'testExitCode') && Object.hasOwn(e.outputs, 'exit_code')).map(e => e.outputs);
    return {attempts, tests, output: events.find(e => e.event === 'run_complete')?.outputs};
}

test('script repair uses real failing tests as AI input and proves the changed script with a second Code test', t => {
    const f = setup(t), original = fs.readFileSync(f.input), r = run(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const evidence = inspect(r);
    assert.equal(evidence.attempts.length, 1);
    assert.equal(evidence.tests.length, 2);
    assert.equal(evidence.tests[0].passed, false);
    assert.notEqual(evidence.tests[0].testExitCode, 0);
    assert.equal(evidence.tests[0].exit_code, 0);
    assert.equal(evidence.attempts[0].inputs.report, evidence.tests[0].report);
    assert.equal(evidence.tests[1].passed, true);
    assert.equal(evidence.tests[1].testExitCode, 0);
    assert.equal(evidence.output.repairs, 1);
    assert.equal(evidence.output.source, 'calculator.py');
    assert.match(r.stdout, /Tests failed/);
    assert.match(r.stdout, /Tests passed/);
    assert.deepEqual(fs.readFileSync(f.input), original);
    assert.deepEqual(fs.readFileSync(path.join(f.output, 'workspace/test_calculator.py')), fs.readFileSync(path.join(sample, 'test_calculator.py')));
    assert.notDeepEqual(fs.readFileSync(path.join(f.output, 'workspace/calculator.py')), original);
});
test('script already passing makes zero AI calls', t => {
    const f = setup(t, correct), r = run(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const e = inspect(r);
    assert.equal(e.attempts.length, 0);
    assert.equal(e.tests.length, 1);
    assert.equal(e.output.repairs, 0);
});
test('second repair uses the latest failure report and can pass within the bound', t => {
    const r = run(setup(t), 'two-repairs');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const e = inspect(r);
    assert.equal(e.attempts.length, 2);
    assert.equal(e.tests.length, 3);
    assert.equal(e.output.repairs, 2);
    assert.equal(e.attempts[1].inputs.report, e.tests[1].report);
    assert.notEqual(e.tests[0].report, e.tests[1].report);
});
for (const mode of ['no-change', 'exit-zero']) test(`unfixed script (${mode}) stops at two repairs without false success`, t => {
    const r = run(setup(t), mode);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const e = inspect(r);
    assert.equal(e.attempts.length, 2);
    assert.equal(e.tests.length, 3);
    assert.equal(e.output.passed, false);
    assert.match(r.stdout, /Repair limit reached/);
    if (mode === 'exit-zero') assert.match(e.tests[2].report, /No confirmed completion/);
});
for (const mode of ['tamper', 'missing', 'different', 'fail']) test(`repair failure (${mode}) stops without automatic replay or claimed passing tests`, t => {
    const r = run(setup(t), mode);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    const e = inspect(r);
    assert.equal(e.attempts.length, 1);
    assert.notEqual(e.output?.passed, true);
    if (mode === 'tamper') assert.match(r.stdout, /Test file changed/);
});
test('a hanging script hits the test-process deadline and supplies timeout feedback to AI', t => {
    const r = run(setup(t, 'while True:\n    pass\n'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const e = inspect(r);
    assert.equal(e.tests[0].testExitCode, -1);
    assert.match(e.attempts[0].inputs.report, /5-second/);
    assert.equal(e.tests[1].passed, true);
});
test('invalid script inputs and an occupied output directory fail without modifying user files', t => {
    const f = setup(t);
    for (const content of [Buffer.from(' '), Buffer.from([255]), Buffer.alloc(65537, 97)]) {
        fs.writeFileSync(f.input, content);
        const r = run(f);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.equal(fs.existsSync(f.output), false);
    }
    fs.writeFileSync(f.input, correct);
    fs.mkdirSync(f.output);
    fs.writeFileSync(path.join(f.output, 'keep.txt'), 'keep');
    assert.equal(run(f).status, 1);
    assert.equal(fs.readFileSync(path.join(f.output, 'keep.txt'), 'utf8'), 'keep');
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const runner = path.join(root, 'examples/local-report/run.cjs');

function fixture(t, items = [{title: '苹果', value: 5}, {title: '二号\n多行', value: 2.5}]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo report '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const input = path.join(dir, 'input.json'), output = path.join(dir, 'output with spaces');
    fs.writeFileSync(input, JSON.stringify(items));
    return {dir, input, output};
}

function invoke(f, answers) {
    return spawnSync(process.execPath, [runner, '--input', f.input, '--output', f.output], {
        encoding: 'utf8',
        input: answers,
        timeout: 15000
    });
}

test('real TS compilation and Python produce a human-approved report from supplied data', t => {
    const f = fixture(t);
    const result = invoke(f, '1\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = fs.readFileSync(path.join(f.output, 'report.md'), 'utf8');
    assert.match(report, /苹果/);
    assert.match(report, /二号\n多行/);
    assert.match(report, /Total: 7\.5/);
    assert.match(result.stdout, /# Local report\n\n- 苹果/);
    assert.match(result.stdout, /Waiting for human/);
    assert.match(result.stdout, /Saved report/);
    const runDir = result.stdout.match(/Records: (.+)\n/)[1];
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'))).status, 'completed');
    assert.ok(fs.existsSync(path.join(runDir, '.snapshot/workflow.main.itt.impl.json')));
    assert.ok(fs.existsSync(path.join(f.output, 'artifacts/workflow.main.sourcemap.json')));
    assert.ok(fs.existsSync(path.join(f.output, 'artifacts/sources/workflow.ts')));
});
test('changed data changes the report and never becomes a shell command', t => {
    const f = fixture(t, [{title: '$(touch SHOULD_NOT_EXIST); `echo wow`', value: 9}, {title: 'negative', value: -2}]);
    const result = invoke(f, '1\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(fs.readFileSync(path.join(f.output, 'report.md'), 'utf8'), /Total: 7\n/);
    assert.equal(fs.existsSync(path.join(f.output, 'SHOULD_NOT_EXIST')), false);
});
test('business refusal never save a report', t => {
    for (const answers of ['2\n']) {
        const f = fixture(t), result = invoke(f, answers);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /not saved/i);
        assert.equal(fs.existsSync(path.join(f.output, 'report.md')), false);
    }
});
test('invalid choice is reprompted and EOF never invents an approval', t => {
    const f = fixture(t);
    const result = invoke(f, 'yes\n1\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Choose one of the listed numbers/);
    const closed = fixture(t), eof = invoke(closed, '');
    assert.notEqual(eof.status, 0);
    assert.match(eof.stdout, /EOF|input closed/);
    assert.match(eof.stdout, /suspended|paused/i);
    assert.equal(fs.existsSync(path.join(closed.output, 'report.md')), false);
});
test('missing/malformed input and existing outputs fail before creating run state', t => {
    const f = fixture(t);
    fs.unlinkSync(f.input);
    let result = invoke(f, '');
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(f.output), false);
    for (const invalid of ['{', '{}', '[]', '[{"title":"a","value":"3"}]', '[{"title":"a","value":-0}]']) {
        fs.writeFileSync(f.input, invalid);
        result = invoke(f, '');
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(f.output), false);
    }
    fs.writeFileSync(f.input, '[{"title":"a","value":1}]');
    fs.mkdirSync(f.output);
    fs.writeFileSync(path.join(f.output, 'keep.txt'), 'keep');
    result = invoke(f, '1\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
    assert.deepEqual(fs.readdirSync(f.output), ['keep.txt']);
});
test('example compile helper rejects invalid DSL before writing artifacts', t => {
    const filename = path.join(root, 'examples/lib/compile.cjs');
    assert.ok(fs.existsSync(filename), 'example compiler helper exists');
    const f = fixture(t);
    const source = path.join(f.dir, 'bad.ts');
    fs.writeFileSync(source, 'export async function main() { await unknown(); }');
    assert.throws(() => require(filename).compileFiles({
        files: {'bad.ts': source},
        entries: [{file: 'bad.ts', exportName: 'main'}],
        outputDir: f.output
    }), /compil|declar|diagnostic/i);
    assert.equal(fs.existsSync(f.output), false);
});

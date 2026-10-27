const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');

// Select the business call and its script argument by syntax, never whitespace.
// Missing/ambiguous targets must fail before starting an apparently useful test.
function injectCodeFailure(source, callee, marker, after = false) {
    const ast = ts.createSourceFile('workflow.ts', source, ts.ScriptTarget.Latest, true);
    assert.equal(ast.parseDiagnostics.length, 0, 'fault input must parse');
    const calls = [];
    function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) calls.push(node);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.equal(calls.length, 1, `Expected exactly one ${callee} call`);
    const script = calls[0].arguments[1];
    assert.ok(script && (ts.isNoSubstitutionTemplateLiteral(script) || ts.isStringLiteral(script)), 'Expected a literal Code script');
    const failure = `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed", encoding="utf-8")\nimport sys\nsys.exit(7)\n`;
    const injected = after ? script.text + '\n' + failure : failure + script.text;
    const literal = ts.createPrinter().printNode(ts.EmitHint.Expression, ts.factory.createStringLiteral(injected), ast);
    return source.slice(0, script.getStart(ast)) + literal + source.slice(script.end);
}

function copyExample(t) {
    const dir = fs.mkdtempSync(path.join(root, '.example-failure-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.cpSync(path.join(root, 'examples'), path.join(dir, 'examples'), {recursive: true});
    const input = path.join(dir, 'input.json');
    fs.writeFileSync(input, '[{"title":"hello","value":2}]');
    return {
        dir,
        input,
        output: path.join(dir, 'output'),
        workflow: path.join(dir, 'examples/local-report/workflow.ts')
    };
}

for (const stage of ['summary', 'save']) for (const format of ['source', 'printed-crlf']) test(`E12 ${stage} nonzero Code exit never reports saved success (${format})`, t => {
    const f = copyExample(t);
    let source = fs.readFileSync(f.workflow, 'utf8');
    if (format === 'printed-crlf') source = ts.createPrinter({newLine: ts.NewLineKind.CarriageReturnLineFeed}).printFile(ts.createSourceFile('workflow.ts', source, ts.ScriptTarget.Latest, true));
    const marker = `injected-${stage}.txt`;
    source = injectCodeFailure(source, stage === 'summary' ? 'summarize_items_by_code' : 'save_report_by_code', marker, stage === 'summary');
    fs.writeFileSync(f.workflow, source);
    const r = spawnSync(process.execPath, [path.join(f.dir, 'examples/local-report/run.cjs'), '--input', f.input, '--output', f.output], {
        input: '1\n',
        encoding: 'utf8',
        timeout: 15000
    });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(f.output, marker), 'utf8'), 'executed', 'the intended Code fault must actually run');
    assert.doesNotMatch(r.stdout, /Saved report:/);
    assert.equal(fs.existsSync(path.join(f.output, 'report.md')), false);
    assert.match(r.stdout, stage === 'summary' ? /Summary code failed; no report saved/ : /Save code failed; inspect output before retrying/);
});

test('Code fault injection rejects missing, ambiguous and nonliteral targets', () => {
    const name = 'summarize_items_by_code';
    assert.throws(() => injectCodeFailure('other_call("python", "pass", {});', name, 'unused'), /exactly one/);
    assert.throws(() => injectCodeFailure(`${name}("python", "pass", {}); ${name}("python", "pass", {});`, name, 'unused'), /exactly one/);
    assert.throws(() => injectCodeFailure(`${name}("python", script, {});`, name, 'unused'), /literal Code script/);
});
test('E1 absent Codex CLI and API keys fail explicitly before creating output', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo no providers '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const env = {
        ...process.env,
        PATH: dir,
        HOME: dir,
        CODEX_HOME: path.join(dir, 'codex'),
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        NODE_OPTIONS: ''
    };
    const r = spawnSync(process.execPath, [path.join(root, 'examples/review-report/run.cjs'), '--provider', 'codex', '--input', path.join(root, 'examples/review-report/input.sample.json'), '--output', path.join(dir, 'output')], {
        env,
        encoding: 'utf8',
        timeout: 5000
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Codex CLI is unavailable/);
    assert.equal(fs.existsSync(path.join(dir, 'output')), false);
    for (const [example, args] of [['script-repair', []], ['document-review', ['--input', path.join(root, 'examples/document-review/brief.sample.md')]]]) {
        const codexOnly = spawnSync(process.execPath, [path.join(root, `examples/${example}/run.cjs`), ...args, '--output', path.join(dir, example)], {
            env,
            encoding: 'utf8',
            timeout: 5000
        });
        assert.equal(codexOnly.status, 1, codexOnly.stdout + codexOnly.stderr);
        assert.match(codexOnly.stderr, /Codex CLI is unavailable.*no offline provider/);
        assert.equal(fs.existsSync(path.join(dir, example)), false);
    }
    const sdk = spawnSync(process.execPath, [path.join(root, 'examples/sdk-text/run.cjs'), '--provider', 'openai', '--input', path.join(root, 'examples/sdk-text/input.txt')], {
        env,
        encoding: 'utf8',
        timeout: 5000
    });
    assert.notEqual(sdk.status, 0);
    assert.match(sdk.stderr, /Set OPENAI_API_KEY/);
});

test('E12 missing Python runner asset fails visibly without fabricated output', async t => {
    const dir = fs.mkdtempSync(path.join(root, '.missing-runner-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.cpSync(path.join(root, 'adapters/code-local/dist'), path.join(dir, 'dist'), {recursive: true});
    fs.unlinkSync(path.join(dir, 'dist/_itt_runner.py'));
    const {executePython} = require(path.join(dir, 'dist/index.js'));
    await assert.rejects(executePython({
        script: 'value = 1',
        inputs: {},
        declaredOutputs: {value: 'number'},
        workspaceDir: dir,
        workingDir: dir
    }), /runner|unavailable|not set/i);
});

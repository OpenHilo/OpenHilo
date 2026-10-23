const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createCodeExecutor, executeCode, executePython} = require('@openhilo/code-local');

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-contracts-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return root;
}

function node(lang, script, outputs) {
    return {id: 'probe', type: 'call', executor: 'code', lang, script, outputs, inputsFrom: {}, outputsTo: {}, next: 'END'};
}

for (const [name, script, exitCode, stderr] of [
    ['ordinary exception', 'raise RuntimeError("expected process failure")', 1, /RuntimeError: expected process failure/],
    ['syntax error', 'def broken(:', 1, /SyntaxError/],
    ['signal exit', 'import os, signal\nos.kill(os.getpid(), signal.SIGTERM)', 143, /^$/],
]) test(`Python ${name} remains exit-code data without business outputs`, async t => {
    const result = await createCodeExecutor(workspace(t))(node('python', script, {stdout: 'text', stderr: 'text', exit_code: 'number'}), {});
    assert.equal(result.outputs.exit_code, exitCode);
    assert.match(result.outputs.stderr, stderr);
});

test('Bash workflow semantics do not change when a business output is added', async t => {
    const execute = createCodeExecutor(workspace(t));
    const script = 'AUDIT_VAR=1 eval ":"; printf "%s" "${AUDIT_VAR-unset}"; result=ok';
    for (const outputs of [{stdout: 'text'}, {stdout: 'text', result: 'text'}]) {
        const result = await execute(node('bash', script, outputs), {});
        assert.equal(result.outputs.stdout, 'unset');
        assert.equal(result.outputs.exit_code, 0);
    }
});

test('direct executeCode keeps its legacy shell default and allows explicit Bash', async t => {
    const config = {command: 'AUDIT_VAR=1 eval ":"; printf "%s" "${AUDIT_VAR-unset}"', envVars: {}, workingDir: workspace(t)};
    assert.equal((await executeCode(config)).text, '1');
    assert.equal((await executeCode({...config, shell: 'bash'})).text, 'unset');
});

for (const lang of ['bash', 'python']) {
    for (const [actual, declared] of [['dir', 'file'], ['file', 'dir']]) {
        test(`${lang} rejects an existing ${actual} declared as ${declared}`, async t => {
            const root = workspace(t);
            if (actual === 'dir') fs.mkdirSync(path.join(root, 'output'));
            else fs.writeFileSync(path.join(root, 'output'), 'data');
            await assert.rejects(createCodeExecutor(root)(node(lang, 'result="output"', {result: declared}), {}), /result.*must be.*(file|dir)/);
        });
    }
    test(`${lang} accepts correct file and directory outputs in a relative workspace`, async t => {
        const root = workspace(t);
        fs.mkdirSync(path.join(root, 'folder'));
        fs.writeFileSync(path.join(root, 'note.txt'), 'data');
        const relativeRoot = path.relative(process.cwd(), root);
        const result = await createCodeExecutor(relativeRoot)(node(lang, 'note="note.txt"; folder="folder"', {note: 'file', folder: 'dir'}), {});
        assert.equal(result.outputs.note.path, 'note.txt');
        assert.match(result.outputs.note.hash, /^sha256:/);
        assert.equal(result.outputs.folder.path, 'folder');
    });
    test(`${lang} rejects an empty file output instead of returning the workspace`, async t => {
        await assert.rejects(createCodeExecutor(workspace(t))(node(lang, 'result=""', {result: 'file'}), {}), /result.*not set/);
    });
}

test('Python failures still reject missing declared business outputs', async t => {
    const root = workspace(t);
    await assert.rejects(executePython({script: 'raise RuntimeError("expected failure")', inputs: {}, declaredOutputs: {value: 'text'}, workingDir: root, workspaceDir: root}), /value.*not set.*exit code 1/s);
});

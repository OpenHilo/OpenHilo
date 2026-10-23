const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {getEventListeners} = require('node:events');
const {executeCode, executePython, createCodeExecutor, CodeProcessError} = require('@openhilo/code-local');
const {AbortError, ExecutionError} = require('@openhilo/runtime-contracts');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-limits-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return root;
}
function run(lang, root, script, options = {}, declaredOutputs = {}) {
    return lang === 'bash'
        ? executeCode({command: script, shell: 'bash', envVars: {}, workingDir: root, declaredOutputs, ...options})
        : executePython({script, inputs: {}, workingDir: root, workspaceDir: root, declaredOutputs, ...options});
}
function reason(expected) {
    return error => {
        assert.ok(error instanceof CodeProcessError);
        assert.ok(error instanceof AbortError);
        assert.equal(error.reason, expected);
        return true;
    };
}
async function untilFile(file) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file)) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
        await delay(10);
    }
}

for (const lang of ['bash', 'python']) {
    test(`${lang}: timeout terminates execution without returning successful outputs`, {timeout: 5000}, async t => {
        const root = workspace(t);
        await assert.rejects(run(lang, root, lang === 'bash' ? 'sleep 1; value=ok' : 'import time\ntime.sleep(1)\nvalue="ok"',
            {timeoutMs: 50, killGraceMs: 30}, {value: 'text'}), reason('timeout'));
    });
    test(`${lang}: pre-cancel has no side effects and live cancellation removes listeners`, {timeout: 5000}, async t => {
        const root = workspace(t), controller = new AbortController();
        controller.abort();
        await assert.rejects(run(lang, root, lang === 'bash' ? 'touch effect' : 'open("effect","w").close()',
            {signal: controller.signal}), reason('cancelled'));
        assert.equal(fs.existsSync(path.join(root, 'effect')), false);
        const live = new AbortController();
        const pending = run(lang, root, lang === 'bash' ? 'touch ready; sleep 2; touch effect'
            : 'import time\nopen("ready","w").close()\ntime.sleep(2)\nopen("effect","w").close()',
        {signal: live.signal, killGraceMs: 30});
        const rejected = assert.rejects(pending, reason('cancelled'));
        await untilFile(path.join(root, 'ready'));
        live.abort();
        await rejected;
        assert.equal(fs.existsSync(path.join(root, 'effect')), false);
        assert.equal(getEventListeners(live.signal, 'abort').length, 0);
    });
    test(`${lang}: stream byte budget combines stdout and stderr, permits exact limit`, async t => {
        const root = workspace(t);
        const script = lang === 'bash' ? 'printf ab; printf cd >&2' : 'import sys\nsys.stdout.write("ab")\nsys.stderr.write("cd")';
        const ok = await run(lang, root, script, {maxOutputBytes: 4});
        assert.equal(ok.text, 'ab'); assert.equal(ok.stderr, 'cd');
        await assert.rejects(run(lang, root, script, {maxOutputBytes: 3, killGraceMs: 0}), error => {
            reason('output_limit')(error);
            assert.ok(Buffer.byteLength(error.stdout) + Buffer.byteLength(error.stderr) <= 3);
            return true;
        });
    });
    test(`${lang}: oversized business result rejects instead of parsing a truncated payload`, async t => {
        const root = workspace(t);
        const script = lang === 'bash' ? 'value=$(printf "%1000s" x)' : 'value="x" * 1000';
        await assert.rejects(run(lang, root, script, {maxResultBytes: 64, killGraceMs: 0}, {value: 'text'}), reason('result_limit'));
        const ok = await run(lang, root, script, {maxResultBytes: 2048}, {value: 'text'});
        assert.equal(ok.typedOutputs[0].value.length, 1000);
    });
    test(`${lang}: cancellation and spawn failure clean protocol files before settling`, async t => {
        const root = workspace(t);
        const script = lang === 'bash'
            ? 'printf "%s" "$_ITT_OUT" > protocol-path; sleep 2'
            : 'import os,time\nopen("protocol-path","w").write(os.environ["_ITT_OUTPUT"])\ntime.sleep(2)';
        const controller = new AbortController();
        const rejected = assert.rejects(run(lang, root, script, {signal: controller.signal, killGraceMs: 0}, {value: 'text'}), reason('cancelled'));
        await untilFile(path.join(root, 'protocol-path'));
        const protocol = fs.readFileSync(path.join(root, 'protocol-path'), 'utf8');
        controller.abort(); await rejected;
        assert.equal(fs.existsSync(protocol), false);
        assert.equal(fs.existsSync(path.dirname(protocol)), false);
        const promises = require('node:fs/promises'), mkdtemp = promises.mkdtemp, temporary = [];
        promises.mkdtemp = async (...args) => {const dir = await mkdtemp(...args); temporary.push(dir); return dir;};
        try {
            await assert.rejects(run(lang, path.join(root, 'missing-cwd'), '', {}, {value: 'text'}), ExecutionError);
            assert.equal(temporary.length, 1);
            for (const dir of temporary) assert.equal(fs.existsSync(dir), false);
        } finally {promises.mkdtemp = mkdtemp;}
    });
}

test('UTF-8 split across pipe chunks is preserved; limits count bytes rather than characters', async t => {
    const root = workspace(t);
    const script = "printf '\\360\\237'; sleep 0.05; printf '\\230\\200'";
    assert.equal((await run('bash', root, script, {maxOutputBytes: 4})).text, '😀');
    await assert.rejects(run('bash', root, script, {maxOutputBytes: 3, killGraceMs: 0}), reason('output_limit'));
});

test('exact protocol byte limits and zero-output budgets work without a race', async t => {
    const root = workspace(t), bytes = Buffer.byteLength('value\0+\0好\0');
    const result = await run('bash', root, 'value=好', {maxOutputBytes: 0, maxResultBytes: bytes}, {value: 'text'});
    assert.equal(result.typedOutputs[0].value, '好');
    await assert.rejects(run('bash', root, 'value=好', {maxResultBytes: bytes - 1, killGraceMs: 0}, {value: 'text'}), reason('result_limit'));
    assert.equal((await run('python', root, 'import time; time.sleep(.05)', {maxOutputBytes: 0, maxResultBytes: 0})).exitCode, 0);
});

test('successful calls remove abort listeners and keep normal nonzero exits as data', async t => {
    const root = workspace(t), controller = new AbortController();
    for (const lang of ['bash', 'python']) {
        const result = await run(lang, root, lang === 'bash' ? 'exit 7' : 'raise SystemExit(7)',
            {timeoutMs: 1000, signal: controller.signal});
        assert.equal(result.exitCode, 7);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
    controller.abort();
});

test('a TERM-ignoring descendant is killed before rejection, including when it closes its pipes', {timeout: 5000}, async t => {
    const root = workspace(t);
    await assert.rejects(run('bash', root,
        '(trap "" TERM; sleep 1; touch escaped-effect) >/dev/null 2>&1 & wait',
        {timeoutMs: 100, killGraceMs: 50}), reason('timeout'));
    await delay(1100);
    assert.equal(fs.existsSync(path.join(root, 'escaped-effect')), false);
});

test('a descendant retaining pipes after its parent exits is still bounded by timeout', {timeout: 5000}, async t => {
    const root = workspace(t);
    await assert.rejects(run('bash', root, '(sleep 1; touch escaped-effect) & exit 0',
        {timeoutMs: 100, killGraceMs: 20}), reason('timeout'));
    await delay(1100);
    assert.equal(fs.existsSync(path.join(root, 'escaped-effect')), false);
});

test('a continuously growing protocol file is stopped while the process is running', {timeout: 5000}, async t => {
    const root = workspace(t);
    await assert.rejects(run('python', root,
        'import os,time\nf=open(os.environ["_ITT_OUTPUT"],"w")\nfor i in range(100):\n f.write("x"*1000); f.flush(); time.sleep(.01)',
        {maxResultBytes: 64, killGraceMs: 0}, {value: 'text'}), reason('result_limit'));
});

test('a fast oversized result also terminates background descendants', {timeout: 5000}, async t => {
    const root = workspace(t);
    await assert.rejects(run('bash', root,
        '(trap "" TERM; sleep 1; touch escaped-effect) >/dev/null 2>&1 & value=$(printf "%1000s" x)',
        {maxResultBytes: 64, killGraceMs: 20}, {value: 'text'}), reason('result_limit'));
    await delay(1100);
    assert.equal(fs.existsSync(path.join(root, 'escaped-effect')), false);
});

test('default capture limit is finite and hosts may explicitly opt out', async t => {
    const root = workspace(t), script = 'print("x" * (11 * 1024 * 1024), end="")';
    await assert.rejects(run('python', root, script, {killGraceMs: 0}), reason('output_limit'));
    assert.equal((await run('python', root, script, {maxOutputBytes: Infinity})).text.length, 11 * 1024 * 1024);
});

test('invalid limits are rejected before launching code', async t => {
    const root = workspace(t);
    for (const options of [{timeoutMs: 0}, {timeoutMs: Infinity}, {timeoutMs: 2 ** 31}, {maxOutputBytes: -1},
        {maxResultBytes: NaN}, {killGraceMs: -1}, {maxOutputBytes: 1.5}, {signal: {}}]) {
        await assert.rejects(run('bash', root, 'touch effect', options), /must be/);
    }
    assert.equal(fs.existsSync(path.join(root, 'effect')), false);
});

test('executor options reach both languages and the old injected implementation API remains usable', async t => {
    const root = workspace(t), seen = [];
    const fake = async config => {seen.push(config); return {text: '', stderr: '', files: [], exitCode: 0, meta: {}};};
    const implementations = {executeCode: fake, executePython: fake};
    const options = {timeoutMs: 250, maxOutputBytes: 400, maxResultBytes: 500};
    const executor = createCodeExecutor(root, options, implementations);
    const node = lang => ({id: 'code', type: 'call', executor: 'code', lang, script: '', outputs: {}, inputsFrom: {}, outputsTo: {}, next: 'END'});
    await executor(node('bash'), {}); await executor(node('python'), {});
    for (const config of seen) for (const [key,value] of Object.entries(options)) assert.equal(config[key], value);
    await createCodeExecutor(root, implementations)(node('bash'), {});
    assert.equal(seen.length, 3);
});

test('runtime aborts a timed-out Code task, releases the lock and refuses replay', {timeout: 5000}, async t => {
    const root = workspace(t), entryFile = path.join(root, 'timeout.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify({version: 2, entry: 'code', nodes: {
        code: {id: 'code', type: 'call', executor: 'code', script: 'sleep 1; touch effect', outputs: {}, inputsFrom: {}, outputsTo: {}, next: 'END'}
    }}));
    const events = [];
    const result = await startRun({intent: 'timeout', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))),
        createResources: () => ({executor: createCodeExecutor(root, {timeoutMs: 50, killGraceMs: 0})}),
        onEvent: event => events.push(event)});
    assert.equal(result.status, 'aborted');
    assert.equal(fs.existsSync(path.join(result.runDir, 'run.lock')), false);
    assert.equal(events.some(e => e.event === 'run_complete'), false);
    assert.equal(fs.existsSync(path.join(root, 'effect')), false);
    await assert.rejects(resumeRun({runDir: result.runDir, createResources: () => {throw new Error('must not replay');}}));
});

test('runtime retains run ownership through process-group escalation', {timeout: 10000}, async t => {
    const root = workspace(t), entryFile = path.join(root, 'cleanup.itt.impl.json');
    const controller = new AbortController();
    fs.writeFileSync(entryFile, JSON.stringify({version: 2, entry: 'code', nodes: {
        code: {id: 'code', type: 'call', executor: 'code',
            script: 'trap "touch terminated; exit 0" TERM; touch ready; while :; do sleep .01; done',
            outputs: {}, inputsFrom: {}, outputsTo: {}, next: 'END'}
    }}));
    let runDir, settled = false;
    const pending = startRun({intent: 'cleanup', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))),
        createResources: context => {
            runDir = context.runDir;
            return {executor: createCodeExecutor(root, {signal: controller.signal, killGraceMs: 500})};
        }}).finally(() => {settled = true;});
    // Wait until the handler is installed instead of assuming process startup
    // finishes within a short timeout on a loaded test host.
    await untilFile(path.join(root, 'ready'));
    controller.abort();
    await untilFile(path.join(root, 'terminated'));
    assert.equal(settled, false);
    assert.equal(fs.existsSync(path.join(runDir, 'run.lock')), true);
    assert.equal((await pending).status, 'aborted');
    assert.equal(fs.existsSync(path.join(runDir, 'run.lock')), false);
});

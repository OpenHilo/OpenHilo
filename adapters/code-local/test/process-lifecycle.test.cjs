const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {executeCode, executePython, createCodeExecutor} = require('@openhilo/code-local');
const {AbortError, ExecutionError} = require('@openhilo/runtime-contracts');

const posix = process.platform !== 'win32';

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-lifecycle-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return root;
}
function bash(root, command, declaredOutputs = {}, options = {}) {
    return executeCode({command, shell: 'bash', envVars: {}, workingDir: root, workspaceDir: root, declaredOutputs, ...options});
}
function python(root, script, declaredOutputs = {}, options = {}) {
    return executePython({script, inputs: {}, workingDir: root, workspaceDir: root, declaredOutputs, ...options});
}
async function untilFile(file) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file)) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${file}`);
        await delay(10);
    }
}
function groupAlive(pgid) {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
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

for (const [name, trigger, expected] of [
    ['SIGINT', child => child.kill('SIGINT'), {signal: 'SIGINT'}],
    ['SIGTERM', child => child.kill('SIGTERM'), {signal: 'SIGTERM'}],
    ['process.exit', child => child.stdin.end('exit'), {code: 3}],
]) test(`host ${name} stops live code process groups and still terminates the host`, {skip: !posix, timeout: 10000}, async t => {
    const root = workspace(t);
    const host = `
        const {createCodeExecutor} = require(${JSON.stringify(require.resolve('@openhilo/code-local'))});
        const run = createCodeExecutor(${JSON.stringify(root)});
        run({type: 'call', executor: 'code', script: 'echo $$ > pgid; (trap "" TERM; sleep 30) & sleep 30', outputs: {}}, {});
        process.stdin.on('data', () => process.exit(3));`;
    const child = spawn(process.execPath, ['-e', host], {stdio: ['pipe', 'inherit', 'inherit']});
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
    await untilFile(path.join(root, 'pgid'));
    await delay(50);
    const pgid = Number(fs.readFileSync(path.join(root, 'pgid'), 'utf8'));
    assert.equal(groupAlive(pgid), true);
    trigger(child);
    const result = await exited;
    if (expected.signal) assert.equal(result.signal, expected.signal);
    else assert.equal(result.code, expected.code);
    await untilGroupGone(pgid);
});

test('host signal listeners keep ownership of the response while code runs', {skip: !posix, timeout: 10000}, async t => {
    const root = workspace(t);
    const host = `
        const {executeCode} = require(${JSON.stringify(require.resolve('@openhilo/code-local'))});
        process.on('SIGINT', () => console.log('host-handled'));
        executeCode({command: 'echo $$ > pgid; sleep 0.5', envVars: {}, workingDir: ${JSON.stringify(root)}})
            .then(() => console.log('completed'));`;
    const child = spawn(process.execPath, ['-e', host], {stdio: ['ignore', 'pipe', 'inherit']});
    let output = '';
    child.stdout.on('data', chunk => {output += chunk;});
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
    await untilFile(path.join(root, 'pgid'));
    child.kill('SIGINT');
    assert.deepEqual(await exited, {code: 0, signal: null});
    assert.match(output, /host-handled/);
});

test('background jobs do not outlive a normally completed task', {skip: !posix, timeout: 10000}, async t => {
    const root = workspace(t);
    const result = await bash(root, 'echo $$ > pgid; nohup sleep 30 >/dev/null 2>&1 & (trap "" TERM; sleep 30) >/dev/null 2>&1 &',
        {}, {killGraceMs: 200});
    assert.equal(result.exitCode, 0);
    assert.equal(groupAlive(Number(fs.readFileSync(path.join(root, 'pgid'), 'utf8'))), false);
});

test('a group that exits on SIGTERM settles without waiting for the whole grace period', {timeout: 10000}, async t => {
    const root = workspace(t), started = Date.now();
    await assert.rejects(bash(root, 'sleep 30', {}, {timeoutMs: 100, killGraceMs: 5000}), error => error.reason === 'timeout');
    assert.ok(Date.now() - started < 2000, `settled after ${Date.now() - started}ms`);
});

test('a missing working directory is reported clearly before launch', async t => {
    const missing = path.join(workspace(t), 'missing');
    for (const run of [() => bash(missing, 'true'), () => python(missing, 'pass')]) {
        await assert.rejects(run(), error => error instanceof ExecutionError && /Working directory does not exist/.test(error.message)
            && error.message.includes(missing));
    }
});

test('output names that are not identifiers are rejected and never reach the shell', async t => {
    const root = workspace(t), marker = path.join(root, 'injected');
    const key = `x}"; touch ${marker}; : "\${x`;
    for (const name of [key, "a'b", 'has space', '1abc', '%s']) {
        await assert.rejects(bash(root, 'true', {[name]: 'text'}), error => error instanceof AbortError && /must match/.test(error.message));
        await assert.rejects(python(root, 'pass', {[name]: 'text'}), error => error instanceof AbortError && /must match/.test(error.message));
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await bash(root, 'pct=%s%d', {pct: 'text'})).typedOutputs[0].value, '%s%d');
});

test('subprocesses receive an allowlisted environment plus explicit host env', async t => {
    const root = workspace(t);
    const previous = process.env.OPENHILO_TEST_SECRET;
    process.env.OPENHILO_TEST_SECRET = 'sk-secret';
    t.after(() => {
        if (previous === undefined) delete process.env.OPENHILO_TEST_SECRET;
        else process.env.OPENHILO_TEST_SECRET = previous;
    });
    const shell = await bash(root, 'printf "%s|%s|%s" "${OPENHILO_TEST_SECRET-unset}" "${EXTRA-unset}" "${PATH:+path}"');
    assert.equal(shell.text, 'unset|unset|path');
    const py = await python(root, 'import os\nprint(os.environ.get("OPENHILO_TEST_SECRET", "unset"), end="")');
    assert.equal(py.text, 'unset');
    const opted = await bash(root, 'printf "%s" "$EXTRA"', {}, {env: {EXTRA: 'granted'}});
    assert.equal(opted.text, 'granted');
    const executor = createCodeExecutor(root, {env: {EXTRA: 'from-executor'}});
    const node = lang => ({type: 'call', executor: 'code', lang, outputs: {},
        script: lang === 'bash' ? 'printf "%s" "$EXTRA"' : 'import os\nprint(os.environ["EXTRA"], end="")'});
    assert.equal((await executor(node('bash'), {})).outputs.stdout, 'from-executor');
    assert.equal((await executor(node('python'), {})).outputs.stdout, 'from-executor');
    await assert.rejects(bash(root, 'true', {}, {env: {BAD: 1}}), /env must be/);
});

test('inputs cannot override interpreter-controlling environment variables', async t => {
    const root = workspace(t), marker = path.join(root, 'sourced');
    fs.writeFileSync(path.join(root, 'evil.sh'), `touch ${JSON.stringify(marker)}\n`);
    for (const name of ['BASH_ENV', 'PATH', 'ENV', 'IFS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH',
        'PYTHONSTARTUP', 'NODE_OPTIONS', 'HOME', 'SHELLOPTS', 'PS4']) {
        await assert.rejects(executeCode({command: 'true', shell: 'bash', envVars: {[name]: path.join(root, 'evil.sh')}, workingDir: root}),
            error => error instanceof AbortError && error.message.includes(`protected environment variable ${name}`));
    }
    assert.equal(fs.existsSync(marker), false);
    const executor = createCodeExecutor(root);
    await assert.rejects(executor({type: 'call', executor: 'code', script: 'true', outputs: {}}, {BASH_ENV: 'evil.sh'}), /protected environment/);
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await executeCode({command: 'printf "%s" "$path"', envVars: {path: 'ok'}, workingDir: root})).text, 'ok');
});

for (const lang of ['bash', 'python']) test(`${lang}: file outputs that resolve outside the workspace through symlinks are rejected`, async t => {
    const root = workspace(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'code-outside-'));
    t.after(() => fs.rmSync(outside, {recursive: true, force: true}));
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link'));
    fs.symlinkSync(outside, path.join(root, 'dirlink'));
    fs.writeFileSync(path.join(root, 'inside'), 'ok');
    fs.symlinkSync(path.join(root, 'inside'), path.join(root, 'inner-link'));
    const run = (value, type) => lang === 'bash' ? bash(root, `f=${value}`, {f: type}) : python(root, `f=${JSON.stringify(value)}`, {f: type});
    for (const [value, type] of [['link', 'file'], ['dirlink/secret', 'file'], ['dirlink', 'dir']]) {
        await assert.rejects(run(value, type), /symlink escapes are rejected/);
    }
    assert.equal((await run('inner-link', 'file')).typedOutputs[0].value.path, 'inner-link');
});

test('user EXIT traps and exec keep declared outputs captured', async t => {
    const root = workspace(t);
    const trapped = await bash(root, 'trap "echo bye; late=set-in-trap" EXIT; out=hello', {out: 'text', late: 'text'});
    assert.equal(trapped.text, 'bye\n');
    assert.deepEqual(trapped.typedOutputs.map(output => output.value), ['hello', 'set-in-trap']);
    const exiting = await bash(root, 'set -eu; trap \'echo "status $?"; exit 4\' EXIT; out=hello; false', {out: 'text'});
    assert.equal(exiting.exitCode, 4);
    assert.equal(exiting.text, 'status 1\n');
    assert.equal(exiting.typedOutputs[0].value, 'hello');
    const reset = await bash(root, 'trap "echo never" EXIT; trap - EXIT; out=ok; trap "echo other" INT', {out: 'text'});
    assert.equal(reset.text, '');
    assert.equal(reset.typedOutputs[0].value, 'ok');
    const subshell = await bash(root, 'out=$( (trap "echo sub-trap" EXIT; true) )', {out: 'text'});
    assert.equal(subshell.typedOutputs[0].value, 'sub-trap');
    const replaced = await bash(root, 'out=before-exec; false || exec echo replaced', {out: 'text'});
    assert.equal(replaced.text, 'replaced\n');
    assert.equal(replaced.typedOutputs[0].value, 'before-exec');
    const redirected = await bash(root, 'exec >log.txt; echo to-log; out=after', {out: 'text'});
    assert.equal(redirected.text, '');
    assert.equal(fs.readFileSync(path.join(root, 'log.txt'), 'utf8'), 'to-log\n');
    assert.equal(redirected.typedOutputs[0].value, 'after');
    const skipped = await bash(root, 'out=kept; true || exec echo never', {out: 'text'});
    assert.equal(skipped.typedOutputs[0].value, 'kept');
});

test('Python runs user code as __main__ and reports non-JSON values clearly', async t => {
    const root = workspace(t);
    const main = await python(root, 'name = __name__\nif __name__ == "__main__":\n    ran = True', {name: 'text', ran: 'boolean'});
    assert.deepEqual(main.typedOutputs.map(output => output.value), ['__main__', true]);
    for (const script of ['x = float("nan")', 'x = {"a": float("inf")}', 'x = {"a": object()}']) {
        await assert.rejects(python(root, script, {x: 'json'}), /not JSON-serializable/);
    }
});

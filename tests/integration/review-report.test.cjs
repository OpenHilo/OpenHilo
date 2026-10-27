const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const run = path.join(root, 'examples/review-report/run.cjs'),
    resume = path.join(root, 'examples/review-report/resume.cjs');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo review '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const input = path.join(dir, 'input.json');
    fs.writeFileSync(input, JSON.stringify({
        topic: '城市里的雨后花园',
        notes: 'Write two short sentences; keep the task small.'
    }));
    return {dir, input, output: path.join(dir, 'output with spaces')};
}

function launch(f, answers = '', extra = []) {
    return spawnSync(process.execPath, [run, '--provider', 'offline', '--input', f.input, '--output', f.output, ...extra], {
        input: answers,
        encoding: 'utf8',
        timeout: 15000
    });
}

function continueRun(runDir, answers, extra = []) {
    return spawnSync(process.execPath, [resume, '--run-dir', runDir, '--provider', 'offline', ...extra], {
        input: answers,
        encoding: 'utf8',
        timeout: 15000
    });
}

function runDir(result) {
    const match = result.stdout.match(/Records: (.+)\n/);
    assert.ok(match, result.stdout + result.stderr);
    return match[1];
}

function events(dir) {
    return fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('scripted AI revises after human feedback, then cross-file formatting and Code save the approved second draft', t => {
    const f = fixture(t), r = launch(f, '2\n加入一只猫\n1\n认可这版\n');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const dir = runDir(r), log = events(dir);
    const ai = log.filter(e => e.event === 'node_pending' && e.executor === 'ai');
    assert.equal(ai.length, 2);
    const report = fs.readFileSync(path.join(f.output, 'report.md'), 'utf8');
    assert.match(report, /城市里的雨后花园/);
    assert.match(report, /加入一只猫/);
    assert.match(report, /Reviewed report/);
    const requests = fs.readFileSync(path.join(dir, 'ai-attempts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].inputs.feedback, '');
    assert.equal(requests[1].inputs.feedback, '加入一只猫');
    assert.equal(requests[1].inputs.previous, requests[0].outputs.report);
    assert.equal(requests[0].provider, 'offline');
    assert.equal(requests[0].usage, null);
    const results = log.filter(e => e.event === 'node_success' && e.outputs && Object.hasOwn(e.outputs, 'approved'));
    assert.deepEqual(results.map(e => e.outputs), [{approved: false, feedback: '加入一只猫'}, {
        approved: true,
        feedback: '认可这版'
    }]);
    assert.doesNotMatch(r.stdout, /1\. Save|2\. Request revision/);
    assert.ok(log.some(e => e.event === 'frame_push' && e.callee === 'format.formatReport'));
    assert.match(r.stdout, /offline.*scripted/i);
    assert.match(r.stdout, /Waiting for human/);
});
test('three unsuccessful reviews stop without claiming approval or writing a report', t => {
    const f = fixture(t), r = launch(f, '2\none\n2\ntwo\n2\nthree\n');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /3.*not approved|not approved.*3/i);
    assert.equal(fs.existsSync(path.join(f.output, 'report.md')), false);
    assert.equal(events(runDir(r)).filter(e => e.event === 'node_pending' && e.executor === 'ai').length, 3);
});
test('EOF leaves review waiting and a fresh process can save the original draft', t => {
    const f = fixture(t), r = launch(f, '');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const dir = runDir(r);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))).status, 'suspended');
    assert.equal(fs.existsSync(path.join(f.output, 'report.md')), false);
    const resumed = continueRun(dir, '1\n\n');
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(events(dir).filter(e => e.event === 'node_pending' && e.executor === 'ai').length, 1);
    assert.ok(fs.existsSync(path.join(f.output, 'report.md')));
});
test('deferred human task resumes in a new process with original snapshot and no replay of the first AI step', t => {
    const f = fixture(t), first = launch(f, '', ['--defer-human']);
    assert.equal(first.status, 2, first.stdout + first.stderr);
    const dir = runDir(first);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))).status, 'suspended');
    // Execute resume from a copied example whose current TS is broken. Only the run snapshot may be read.
    const copy = fs.mkdtempSync(path.join(root, '.review-resume-test-'));
    t.after(() => fs.rmSync(copy, {recursive: true, force: true}));
    fs.cpSync(path.join(root, 'examples'), copy, {recursive: true});
    fs.writeFileSync(path.join(copy, 'review-report/workflow.ts'), 'invalid current source');
    const resumed = spawnSync(process.execPath, [path.join(copy, 'review-report/resume.cjs'), '--run-dir', dir, '--provider', 'offline'], {
        input: '2\n再加蝴蝶\n1\n\n',
        encoding: 'utf8',
        timeout: 15000
    });
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(runDir(resumed), dir);
    assert.equal(events(dir).filter(e => e.event === 'run_start').length, 1);
    assert.equal(events(dir).filter(e => e.event === 'run_resume').length, 1);
    assert.equal(events(dir).filter(e => e.event === 'node_pending' && e.executor === 'ai').length, 2);
    assert.match(fs.readFileSync(path.join(f.output, 'report.md'), 'utf8'), /再加蝴蝶/);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'run.json')));
    assert.equal(record.status, 'completed');
});
test('resume provider mismatch fails before changing saved state or creating another attempt', t => {
    const f = fixture(t), first = launch(f, '', ['--defer-human']);
    assert.equal(first.status, 2, first.stdout + first.stderr);
    const dir = runDir(first);
    const before = fs.readFileSync(path.join(dir, 'execution.jsonl'));
    const r = spawnSync(process.execPath, [resume, '--run-dir', dir, '--provider', 'codex'], {
        input: '',
        encoding: 'utf8',
        timeout: 5000
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /provider.*mismatch/i);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'execution.jsonl')), before);
});
test('resume from the top-level output directory explains which Records path to use', t => {
    const f = fixture(t), first = launch(f, '', ['--defer-human']);
    assert.equal(first.status, 2, first.stdout + first.stderr);
    const r = continueRun(f.output, '');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /complete printed Records path/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir(first), 'run.json'))).status, 'suspended');
});
test('explicit provider and valid input are required before effects', t => {
    const f = fixture(t);
    let r = spawnSync(process.execPath, [run, '--input', f.input, '--output', f.output], {
        encoding: 'utf8',
        timeout: 5000
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /provider/);
    assert.equal(fs.existsSync(f.output), false);
    fs.writeFileSync(f.input, '{"topic":"   "}');
    r = launch(f);
    assert.notEqual(r.status, 0);
    assert.equal(fs.existsSync(f.output), false);
});

test('real terminal Ctrl+C leaves review waiting and a fresh process resumes without replay', t => {
    const f = fixture(t);
    // Python's standard-library PTY creates an actual controlling terminal; do not
    // emulate isTTY or send SIGINT directly to the Node process.
    const driver = String.raw`
import errno, json, os, pty, select, signal, sys, time
try:
    pid, fd = pty.fork()
except OSError as error:
    print(json.dumps({'unavailable': str(error)}))
    sys.exit(0)
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
transcript = bytearray()
interrupted = False
status = None
try:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b''
            transcript.extend(data)
            if not interrupted and b'Choose a number: ' in transcript:
                os.write(fd, b'\x03')
                interrupted = True
        ended, result = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = os.waitstatus_to_exitcode(result)
            break
    if status is None:
        raise RuntimeError('Ctrl+C did not settle the terminal review')
finally:
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(fd)
print(json.dumps({'status': status, 'interrupted': interrupted, 'stdout': transcript.decode('utf-8', errors='replace')}))
`;
    const ttyEnv = {...process.env, TERM: 'xterm-256color'};
    delete ttyEnv.NO_COLOR;
    const result = spawnSync('python3', ['-c', driver, process.execPath, run, '--provider', 'offline', '--input', f.input, '--output', f.output], {
        encoding: 'utf8',
        timeout: 15000,
        env: ttyEnv
    });
    if (result.error?.code === 'ENOENT') return t.skip('python3 is not available to open a pseudo-terminal');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const first = JSON.parse(result.stdout);
    if (first.unavailable) return t.skip(`a pseudo-terminal cannot be opened: ${first.unavailable}`);
    assert.match(first.stdout, /\x1b\[2m\[log\]/, 'TTY logs should be dim');
    assert.match(first.stdout, /\x1b\[1mChoose a number: \x1b\[22m/, 'input prompt should stand out');
    first.stdout = first.stdout.replaceAll('\r\n', '\n').replace(/\x1b\[[0-9;]*m/g, '');
    first.stderr = '';
    assert.equal(first.interrupted, true);
    assert.equal(first.status, 2, first.stdout);
    assert.match(first.stdout, /SIGINT/);
    const dir = runDir(first);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))).status, 'suspended');
    assert.equal(fs.existsSync(path.join(f.output, 'report.md')), false);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8'), /\x1b/);
    const resumed = continueRun(dir, '1\n\n');
    assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(events(dir).filter(event => event.event === 'node_pending' && event.executor === 'ai').length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'))).status, 'completed');
    assert.ok(fs.existsSync(path.join(f.output, 'report.md')));
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runExample} = require('../examples/suspend-resume.cjs');
const {Rehydrator, EvalEngine, AbortError, Logger, FailableError} = require('../dist');

test('independent runtime completes AI → human suspension → recovery without replaying AI', async () => {
    const result = await runExample();
    assert.equal(result.outputs.answer, 'Independent runtime works');
    assert.equal(result.aiCalls, 1);
    assert.equal(result.status, 'completed');
    assert.ok(result.events.includes('suspended_state'));
    assert.ok(result.events.includes('run_resume'));
    assert.equal(result.events.at(-1), 'run_complete');
});

test('public errors retain identity across the runtime and contract package', async () => {
    const contracts = require('@openhilo/runtime-contracts');
    assert.equal(AbortError, contracts.AbortError);
    assert.equal(FailableError, contracts.FailableError);
    const evaluator = new EvalEngine();
    await assert.rejects(evaluator.eval('missing', {}), AbortError);
    await evaluator.stop();
});

test('large event outputs retain the existing external-file reference format', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-log-package-'));
    try {
        fs.mkdirSync(path.join(dir, 'io_records'));
        const logger = new Logger(dir, 'test');
        logger.init();
        logger.append({event: 'node_success', ts: 1, node_run_id: 'n1', outputs: {content: 'x'.repeat(65536)}});
        const event = JSON.parse(fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8'));
        assert.equal(event.outputs.content.type, 'file_ref');
        assert.match(event.outputs.content.hash, /^sha256:/);
        assert.equal(fs.readFileSync(path.join(dir, event.outputs.content.path), 'utf8').length, 65536);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('absence of a controlled suspension never invents recoverable state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-rehydrate-package-'));
    try {
        fs.writeFileSync(path.join(dir, 'execution.jsonl'), JSON.stringify({
            event: 'node_running',
            ts: 1,
            node_run_id: 'n1'
        }) + '\n');
        assert.deepEqual(new Rehydrator(dir).rehydrate(), {kind: 'no_suspended_state'});
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('a truncated or invalid terminal record cannot revive an older suspension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-terminal-log-'));
    try {
        const saved = JSON.stringify({event: 'suspended_state', ts: 1, call_stack: [], global_seq: 1});
        for (const tail of ['{"event":"node_running"', 'null', '{}']) {
            fs.writeFileSync(path.join(dir, 'execution.jsonl'), saved + '\n' + tail + '\n');
            assert.deepEqual(new Rehydrator(dir).rehydrate(), {kind: 'no_suspended_state'});
        }
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
});

test('concurrent readers always see a complete run receipt during status updates', async t => {
    const {Worker} = require('node:worker_threads');
    const {once} = require('node:events');
    const {RunManager} = require('../dist/run-manager');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-receipt-read-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const manager = RunManager.create({runsDir: root, intent: 'probe', workdir: root});
    const file = path.join(manager.runDir, 'run.json');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({...receipt, retained: 'metadata'}));
    const control = new SharedArrayBuffer(4);
    const reader = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs'); const control = new Int32Array(workerData.control);
    let reads = 0, invalid = 0, firstError;
    parentPort.postMessage('ready');
    do {
      try {
        const data = JSON.parse(fs.readFileSync(workerData.file, 'utf8'));
        if (data.run_id !== workerData.id || data.retained !== 'metadata') throw new Error('Lost receipt identity or metadata');
      } catch (error) { invalid++; firstError ??= error.message; }
      reads++;
    } while (!Atomics.load(control, 0));
    parentPort.postMessage({ reads, invalid, firstError });
  `, {eval: true, workerData: {file, control, id: manager.runId}});
    t.after(() => reader.terminate());
    await once(reader, 'message');
    const result = once(reader, 'message');
    for (let i = 0; i < 2000; i++) manager.update_status(i % 2 ? 'running' : 'suspended');
    Atomics.store(new Int32Array(control), 0, 1);
    const [observed] = await result;
    assert.ok(observed.reads > 0);
    assert.equal(observed.invalid, 0, JSON.stringify(observed));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).retained, 'metadata');
});

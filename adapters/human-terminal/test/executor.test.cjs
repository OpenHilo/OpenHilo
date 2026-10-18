const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {TerminalHumanExecutor} = require('../dist');
const request = {
    version: 1,
    taskId: 'task-1',
    runId: 'run-1',
    nodeId: 'review',
    nodeRunId: 'nr-1',
    prompt: 'Review this change',
    inputs: {title: 'A proposal'},
    outputs: {},
    createdAt: '2026-10-03T00:00:00Z'
};

function host(status = 'accepted', controller = new AbortController()) {
    const submissions = [];
    return {
        signal: controller.signal, submissions, async submit(s) {
            submissions.push(s);
            return {status, taskId: s.taskId, submissionId: s.submissionId, message: 'Receipt detail'};
        }
    };
}

function answers(values, prompts = [], writes = []) {
    return {
        promptFn: async prompt => {
            prompts.push(prompt);
            assert.ok(values.length, 'unexpected additional prompt');
            return values.shift();
        }, write: text => writes.push(text)
    };
}

test('zero-output tasks require explicit numbered completion, reprompting empty or ambiguous input', async () => {
    const h = host();
    const prompts = [];
    await new TerminalHumanExecutor(answers(['', 'maybe', '1'], prompts)).present(request, h);
    assert.equal(prompts.length, 3);
    assert.equal(h.submissions.length, 1);
    assert.deepEqual({...h.submissions[0], submissionId: 'generated'}, {
        taskId: 'task-1',
        submissionId: 'generated',
        outputs: {}
    });
    assert.match(h.submissions[0].submissionId, /^[a-f0-9-]{36}$/);
});

test('boolean fields use numbered Yes/No choices without a protocol decision', async () => {
    for (const [answer, expected] of [['1', 'true'], ['2', 'false']]) {
        const h = host();
        const writes = [];
        const prompts = [];
        await new TerminalHumanExecutor(answers([answer], prompts, writes)).present({
            ...request,
            outputs: {approved: 'boolean'}
        }, h);
        assert.deepEqual(h.submissions[0].outputs, {approved: expected});
        assert.equal(Object.hasOwn(h.submissions[0], 'decision'), false);
        assert.match(writes.join(''), /1\. Yes/);
        assert.match(writes.join(''), /2\. No/);
        assert.doesNotMatch(prompts.join(''), /confirm|reject/i);
    }
});

test('invalid typed fields are reprompted and text whitespace is preserved', async () => {
    const h = host();
    const prompts = [];
    const writes = [];
    await new TerminalHumanExecutor(answers(['12abc', '12', 'true', '', '2', '{broken', '{"ok":true}', '  exact text  '], prompts, writes))
        .present({...request, outputs: {n: 'number', b: 'boolean', j: 'json', text: 'text'}}, h);
    assert.deepEqual(h.submissions[0].outputs, {n: '12', b: 'false', j: '{"ok":true}', text: '  exact text  '});
    assert.equal(prompts.length, 8);
    assert.match(writes.join(''), /Invalid number/);
    assert.match(writes.join(''), /Review this change/);
    assert.match(writes.join(''), /A proposal/);
});

test('all declared business fields are collected without preset answers or actions', async () => {
    for (const choice of ['1', '2']) {
        const h = host(), prompts = [], writes = [];
        await new TerminalHumanExecutor(answers([choice, '  my result  '], prompts, writes))
            .present({
                ...request,
                inputs: {report: 'First line\nSecond line'},
                outputs: {approved: 'boolean', feedback: 'text'}
            }, h);
        assert.deepEqual(h.submissions[0].outputs, {
            approved: choice === '1' ? 'true' : 'false',
            feedback: '  my result  '
        });
        assert.equal(prompts.length, 2);
        assert.match(prompts[1], /feedback/);
        assert.match(writes.join(''), /First line\nSecond line/);
        assert.doesNotMatch(writes.join(''), /Save|Request revision/);
    }
});

test('unsuccessful receipts fail meaningfully and duplicates are successful', async () => {
    for (const status of ['invalid', 'stale', 'conflict']) {
        await assert.rejects(new TerminalHumanExecutor(answers(['1'])).present(request, host(status)), new RegExp(`${status}.*Receipt detail`));
    }
    await new TerminalHumanExecutor(answers(['1'])).present(request, host('duplicate'));
});

test('abort settles even when an injected prompt never resolves and cannot submit late', async () => {
    const controller = new AbortController();
    const h = host('accepted', controller);
    let resolvePrompt;
    const running = new TerminalHumanExecutor({
        promptFn: () => new Promise(resolve => {
            resolvePrompt = resolve;
        }), write() {
        }
    }).present(request, h);
    controller.abort();
    await assert.rejects(running, /abort/i);
    resolvePrompt('1');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.submissions, []);
});

test('already aborted tasks never prompt or submit, and prompt EOF never confirms', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = host('accepted', controller);
    await assert.rejects(new TerminalHumanExecutor(answers([])).present(request, h), /abort/i);
    const eofHost = host();
    await assert.rejects(new TerminalHumanExecutor({
        promptFn: async () => {
            throw new Error('EOF');
        }, write() {
        }
    }).present(request, eofHost), /EOF/);
    assert.deepEqual(eofHost.submissions, []);
});

test('default readline settles and releases stdin on EOF or cancellation', async () => {
    for (const action of ['eof', 'abort']) {
        const source = `const { TerminalHumanExecutor } = require('./dist');
      const controller = new AbortController();
      new TerminalHumanExecutor().present(${JSON.stringify(request)}, { signal: controller.signal, submit() { throw new Error('UNEXPECTED_SUBMISSION'); } })
        .then(() => { process.exitCode = 2; }, error => { console.error(error.message); });
      ${action === 'abort' ? 'setTimeout(() => controller.abort(), 20);' : ''}`;
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', source], {
                cwd: require('node:path').resolve(__dirname, '..'),
                stdio: ['pipe', 'pipe', 'pipe']
            });
            let stderr = '';
            child.stderr.on('data', data => stderr += data);
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`${action} left readline pending`));
            }, 2000);
            child.on('error', reject);
            child.on('exit', code => {
                clearTimeout(timer);
                resolve({code, stderr});
            });
            if (action === 'eof') child.stdin.end();
        });
        assert.equal(result.code, 0);
        assert.match(result.stderr, action === 'eof' ? /EOF|closed/i : /abort/i);
        assert.doesNotMatch(result.stderr, /UNEXPECTED_SUBMISSION/);
    }
});

test('cancellation also settles a presentation while the submission receipt is pending', async () => {
    const controller = new AbortController();
    let submitting;
    const started = new Promise(resolve => {
        submitting = resolve;
    });
    const h = {
        signal: controller.signal, submit() {
            submitting();
            return new Promise(() => {
            });
        }
    };
    const running = new TerminalHumanExecutor(answers(['1'])).present(request, h);
    await started;
    controller.abort();
    const outcome = await Promise.race([
        running.then(() => 'resolved', error => error.name),
        new Promise(resolve => setTimeout(() => resolve('still pending'), 30)),
    ]);
    assert.equal(outcome, 'AbortError');
});

test('terminal Ctrl+C reports interruption during prompts and pending receipts', async () => {
    for (const pendingReceipt of [false, true]) {
        const source = `const { TerminalHumanExecutor } = require('./dist');
      process.stdin.isTTY = true; process.stdout.isTTY = true;
      let submissions = 0;
      new TerminalHumanExecutor().present(${JSON.stringify(request)}, {
        signal: new AbortController().signal,
        submit() { submissions++; process.stdout.write('RECEIPT_PENDING'); return new Promise(() => {}); }
      }).then(() => { process.exitCode = 2; }, error => {
        console.error(JSON.stringify({ name: error.name, message: error.message, submissions }));
      });`;
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', source], {
                cwd: require('node:path').resolve(__dirname, '..'),
                stdio: ['pipe', 'pipe', 'pipe']
            });
            let stdout = '', stderr = '', decided = false, interrupted = false;
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error('Ctrl+C left presentation pending'));
            }, 2000);
            child.stdout.on('data', data => {
                stdout += data;
                if (pendingReceipt && !decided && stdout.includes('Choose a number:')) {
                    decided = true;
                    child.stdin.write('1\n');
                }
                if (!interrupted && stdout.includes(pendingReceipt ? 'RECEIPT_PENDING' : 'Choose a number:')) {
                    interrupted = true;
                    child.stdin.write('\x03');
                }
            });
            child.stderr.on('data', data => stderr += data);
            child.on('error', reject);
            child.on('exit', code => {
                clearTimeout(timer);
                resolve({code, stderr});
            });
        });
        assert.equal(result.code, 0);
        const failure = JSON.parse(result.stderr.trim());
        assert.equal(failure.name, 'AbortError');
        assert.match(failure.message, /SIGINT/);
        assert.equal(failure.submissions, pendingReceipt ? 1 : 0);
    }
});

test('default readline submits complete numeric choices and preserves text in real subprocesses', async () => {
    const {spawnSync} = require('node:child_process');
    for (const [outputs, input, expected] of [
        [{}, '\n0\n1\n', {}],
        [{approved: 'boolean'}, '2\n', {approved: 'false'}],
        [{
            title: 'text',
            count: 'number',
            meta: 'json',
            ready: 'boolean'
        }, '  keep  \nwrong\n3\n{"ok":true}\n1\n', {title: '  keep  ', count: '3', meta: '{"ok":true}', ready: 'true'}],
    ]) {
        const source = `const { TerminalHumanExecutor } = require('./dist');
      new TerminalHumanExecutor().present(${JSON.stringify({...request, outputs})}, {
        signal: new AbortController().signal,
        async submit(value) { console.error(JSON.stringify(value)); return { status: 'accepted', taskId: value.taskId, submissionId: value.submissionId }; }
      }).catch(error => { console.error(error.message); process.exitCode = 1; });`;
        const child = spawnSync(process.execPath, ['-e', source], {
            cwd: require('node:path').resolve(__dirname, '..'),
            input,
            encoding: 'utf8',
            timeout: 2000
        });
        assert.equal(child.status, 0, child.stdout + child.stderr);
        const submission = JSON.parse(child.stderr.trim());
        assert.deepEqual(submission.outputs, expected);
        assert.equal(Object.hasOwn(submission, 'decision'), false);
        assert.doesNotMatch(child.stdout, /confirm\/reject/);
    }
});

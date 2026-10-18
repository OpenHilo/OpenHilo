// Offline fixture only. It edits real files; Python's actual fixed suite decides pass/fail.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {fileURLToPath} = require('node:url');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const {runScriptRepair, exitCode} = require('../../examples/script-repair/run.cjs');
const correct = 'def average(values):\n    if not values:\n        raise ValueError("empty")\n    return sum(values) / len(values)\n';
let calls = 0;
const aiExecutor = {
    id: 'test.script-files', capabilities: ['structured_output', 'workspace'], start(request, host) {
        return Promise.resolve(createTaskExecution(request, host, async () => {
            calls++;
            const workspace = fileURLToPath(host.workspace.uri), mode = process.env.SCRIPT_FIXTURE_MODE;
            assert.equal(request.inputs.source, 'calculator.py');
            assert.equal(request.inputs.tests, 'test_calculator.py');
            assert.match(request.inputs.report, /FAIL|ERROR|5-second|No confirmed/);
            const source = path.join(workspace, request.inputs.source);
            if (mode === 'fail') return {
                status: 'failed',
                error: {code: 'executor_failed', message: 'fixture unavailable', retryable: false, safeToReplay: false}
            };
            if (mode === 'missing') {
                fs.unlinkSync(source);
                return {status: 'completed', outputs: {source: 'calculator.py'}, artifacts: []};
            }
            if (mode === 'different') {
                fs.writeFileSync(path.join(workspace, 'other.py'), correct);
                return {status: 'completed', outputs: {source: 'other.py'}, artifacts: []};
            }
            if (mode === 'tamper') fs.writeFileSync(path.join(workspace, request.inputs.tests), 'print("tests passed")');
            if (mode === 'exit-zero') fs.writeFileSync(source, 'import sys\nsys.exit(0)\n');
            else if (mode !== 'no-change') fs.writeFileSync(source, mode === 'two-repairs' && calls === 1 ? 'def average(values):\n    return sum(values) / len(values)\n' : correct);
            return {status: 'completed', outputs: {source: 'calculator.py'}, artifacts: []};
        }));
    }
};
runScriptRepair({input: process.argv[2], output: process.argv[3], aiExecutor})
    .then(result => {
        process.exitCode = exitCode(result);
    })
    .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });

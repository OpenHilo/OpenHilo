const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {executeCode, executePython} = require('@openhilo/code-local');

test('failed processes retain their exit and stderr when declared outputs are unavailable', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-failure-context-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    await assert.rejects(executeCode({
            command: 'echo QA_EXPECTED_TOOL_FAILURE >&2; exit 17',
            envVars: {}, workingDir: root, declaredOutputs: {value: 'text'}
        }),
        error => /code output 'value' not set/.test(error.message)
            && /exit code 17/.test(error.message) && /QA_EXPECTED_TOOL_FAILURE/.test(error.message));
    await assert.rejects(executePython({
            script: 'raise RuntimeError("QA_PYTHON_FAILURE")',
            inputs: {}, workingDir: root, workspaceDir: root, declaredOutputs: {value: 'text'}
        }),
        error => /code output 'value' not set/.test(error.message)
            && /exit code 1/.test(error.message) && /QA_PYTHON_FAILURE/.test(error.message));
});

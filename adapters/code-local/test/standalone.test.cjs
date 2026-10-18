const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {executeCode, executePython, createCodeExecutor} = require('@openhilo/code-local');
const {startRun} = require('@openhilo/runtime/run-service');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createTaskExecution} = require('@openhilo/ai-contracts');

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-adapter-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    return root;
}

test('packed Bash/Python adapter preserves typed inputs, files and outputs', async t => {
    const root = workspace(t), execute = createCodeExecutor(root);
    const bash = await execute({
        id: 'bash',
        type: 'call',
        executor: 'code',
        script: 'total=$((count+2)); printf hello > note.txt; note=note.txt',
        outputs: {total: 'number', note: 'file'},
        inputsFrom: {},
        outputsTo: {},
        next: 'END'
    }, {count: 3});
    assert.equal(bash.outputs.total, 5);
    assert.equal(bash.outputs.note.path, 'note.txt');
    const python = await execute({
            id: 'python', type: 'call', executor: 'code', lang: 'python',
            script: 'total = count * 2\ntext = open(note).read()\ndata = {"enabled": enabled, "items": items}',
            outputs: {total: 'number', text: 'text', data: 'json'}, inputsFrom: {}, outputsTo: {}, next: 'END'
        },
        {count: bash.outputs.total, note: bash.outputs.note, enabled: true, items: [1, 2]});
    assert.equal(python.outputs.total, 10);
    assert.equal(python.outputs.text, 'hello');
    assert.deepEqual(python.outputs.data, {enabled: true, items: [1, 2]});
});

test('signal termination and Python SystemExit retain unsuccessful exit codes', async t => {
    const root = workspace(t);
    assert.equal((await executeCode({command: 'kill -TERM $$', envVars: {}, workingDir: root})).exitCode, 143);
    const result = await executePython({
        script: 'import sys\nvalue = 9\nsys.exit(7)',
        inputs: {},
        declaredOutputs: {value: 'number'},
        workspaceDir: root,
        workingDir: root
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.typedOutputs[0].value, 9);
});

test('missing and incorrectly typed declared outputs fail visibly', async t => {
    const root = workspace(t);
    await assert.rejects(executeCode({
        command: 'flag=yes',
        envVars: {},
        workingDir: root,
        declaredOutputs: {flag: 'boolean'}
    }), /expected "true"/);
    await assert.rejects(executePython({
        script: 'pass',
        inputs: {},
        declaredOutputs: {value: 'number'},
        workspaceDir: root,
        workingDir: root
    }), /not set/);
});

test('independent runtime composes AI, Bash, Python and a system host in one workflow', async t => {
    const root = workspace(t);
    const entryFile = path.join(root, 'mixed.itt.impl.json');
    let aiCalls = 0, observed;
    const node = (id, executor, next, extra) => ({
        id,
        type: 'call',
        executor,
        inputsFrom: {},
        outputsTo: {},
        outputs: {},
        next, ...extra
    });
    const workflow = {
        version: 2, entry: 'ai', nodes: {
            ai: node('ai', 'ai', 'bash', {
                intent: 'Return the seed',
                outputs: {seed: 'number'},
                outputsTo: {seed: 'seed'}
            }),
            bash: node('bash', 'code', 'python', {
                script: 'count=$((seed+2))',
                inputsFrom: {seed: '$seed'},
                outputs: {count: 'number'},
                outputsTo: {count: 'count'}
            }),
            python: node('python', 'code', 'sys', {
                lang: 'python',
                script: 'total = count * 2',
                inputsFrom: {count: '$count'},
                outputs: {total: 'number'},
                outputsTo: {total: 'total'}
            }),
            sys: node('sys', 'sys', 'END', {callee: 'capture', inputsFrom: {total: '$total'}}),
        }
    };
    fs.writeFileSync(entryFile, JSON.stringify(workflow));
    const aiExecutor = {
        id: 'offline', capabilities: ['workspace', 'structured_output'], async start(request, host) {
            aiCalls++;
            return createTaskExecution(request, host, async () => ({
                status: 'completed',
                outputs: {seed: 3},
                artifacts: []
            }));
        }
    };
    const result = await startRun({
        intent: 'mixed', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))),
        createResources: ({runId, workdir}) => ({
            executor: createDispatcher({
                runId, workdir, aiExecutor, codeExecutor: createCodeExecutor(workdir),
                sysExecutor: async (_node, inputs) => {
                    observed = inputs;
                    return {outputs: {}};
                }
            })
        }),
    });
    assert.equal(result.status, 'completed');
    assert.equal(aiCalls, 1);
    assert.deepEqual(observed, {total: 10});
});

test('Bash and Python preserve legal prototype-named inputs and declared outputs', async t => {
    const execute = createCodeExecutor(workspace(t));
    const node = (lang, script, type) => ({
        id: 'prototype-name', type: 'call', executor: 'code', lang, script,
        outputs: JSON.parse(`{"__proto__":"${type}"}`), inputsFrom: {}, outputsTo: {}, next: 'END'
    });
    const bash = await execute(node('bash', '__proto__="${__proto__}-out"', 'text'), JSON.parse('{"__proto__":"input"}'));
    assert.equal(Object.hasOwn(bash.outputs, '__proto__'), true);
    assert.equal(bash.outputs.__proto__, 'input-out');
    const python = await execute(node('python', '__proto__ = {"observed": __proto__["seed"] + 1}', 'json'), JSON.parse('{"__proto__":{"seed":2}}'));
    assert.equal(Object.hasOwn(python.outputs, '__proto__'), true);
    assert.deepEqual(python.outputs.__proto__, {observed: 3});
    assert.equal(Object.getPrototypeOf(python.outputs), Object.prototype);
});

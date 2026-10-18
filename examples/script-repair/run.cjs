#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {parseArgs} = require('node:util');
const {startRun} = require('@openhilo/runtime/run-service');
const {CodexTaskExecutor} = require('@openhilo/ai-codex');
const {compileFiles} = require('../lib/compile.cjs');
const {checkProvider, createResources} = require('../lib/resources.cjs');
const {createRunConsole, createTerminalOutput} = require('../lib/console.cjs');

async function runScriptRepair({input = path.join(__dirname, 'sample/calculator.py'), output, aiExecutor}) {
    if (!output) throw new Error('Provide --output <new directory>');
    const stat = fs.statSync(input);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Input must be a UTF-8 Python file of at most 64 KiB');
    const source = fs.readFileSync(input);
    if (!new TextDecoder('utf-8', {fatal: true}).decode(source).trim()) throw new Error('Input script must not be empty');
    output = path.resolve(output);
    if (fs.existsSync(output)) throw new Error('Output already exists; choose a new directory');
    const tests = fs.readFileSync(path.join(__dirname, 'sample/test_calculator.py'));
    const expectedTestHash = createHash('sha256').update(tests).digest('hex');
    const version = aiExecutor ? 'injected example test adapter' : checkProvider('codex');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.mkdirSync(output);
    const workdir = path.join(output, 'workspace');
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, 'calculator.py'), source, {flag: 'wx'});
    fs.writeFileSync(path.join(workdir, 'test_calculator.py'), tests, {flag: 'wx'});
    const compiled = compileFiles({
        files: {'workflow.ts': path.join(__dirname, 'workflow.ts')},
        entries: [{file: 'workflow.ts', exportName: 'main'}], outputDir: path.join(output, 'artifacts')
    });
    const terminal = createTerminalOutput(), display = createRunConsole();
    terminal.log(`Provider: ${version}. Code tests first; at most two AI repairs and three test runs. Workspace: ${workdir}\n`);
    const run = await startRun({
        intent: 'workflow.main',
        entryFile: compiled.entryFile,
        workdir,
        runsDir: path.join(output, 'runs'),
        inputs: {source: 'calculator.py', tests: 'test_calculator.py', expectedTestHash},
        inputEncoding: 'typed-text-v1',
        receipt: {example: 'script-repair', provider: 'codex', codexVersion: aiExecutor ? null : version},
        onEvent(event) {
            display.onEvent(event);
            if (event.event === 'node_success' && Object.hasOwn(event.outputs ?? {}, 'testExitCode') && Object.hasOwn(event.outputs, 'exit_code')) {
                terminal.info(`Tests ${event.outputs.passed ? 'passed' : 'failed'} (test process exit ${event.outputs.testExitCode}):\n${event.outputs.report}\n`);
            }
        },
        populateSnapshot: ({snapshotDir}) => fs.cpSync(compiled.artifactsDir, snapshotDir, {recursive: true}),
        createResources: context => createResources(context, {
            provider: 'codex',
            aiExecutor: aiExecutor ?? new CodexTaskExecutor({
                sandbox: 'workspace-write',
                effort: 'low',
                timeoutMs: 120000
            }),
        }),
    });
    display.finish(run);
    if (run.status === 'completed') terminal.info(`${display.outputs.reason}; AI repairs: ${display.outputs.repairs}\nScript: ${path.join(workdir, 'calculator.py')}\n`);
    return {...run, outputs: display.outputs};
}

const exitCode = result => result.status === 'completed' && result.outputs?.passed ? 0 : 2;

async function main(args) {
    const {values} = parseArgs({args, options: {input: {type: 'string'}, output: {type: 'string'}}});
    return exitCode(await runScriptRepair({input: values.input, output: values.output}));
}

if (require.main === module) main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {runScriptRepair, exitCode, main};

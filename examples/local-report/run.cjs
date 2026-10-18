#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {startRun} = require('@openhilo/runtime/run-service');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createCodeExecutor} = require('@openhilo/code-local');
const {compileFiles} = require('../lib/compile.cjs');
const {createRunConsole, createTerminalHuman, createTerminalOutput} = require('../lib/console.cjs');

async function runLocalReport({input, output}) {
    let items;
    try {
        items = JSON.parse(fs.readFileSync(input, 'utf8'));
    } catch (error) {
        throw new Error(`Cannot read input JSON: ${error.message}`);
    }
    if (!Array.isArray(items) || !items.length || items.some(item => !item || typeof item.title !== 'string' || !item.title.trim() || typeof item.value !== 'number' || !Number.isFinite(item.value) || Object.is(item.value, -0))) {
        throw new Error('Input must be a nonempty array of { title: nonempty string, value: finite number }; negative zero is unsupported.');
    }
    if (!Number.isFinite(items.reduce((sum, item) => sum + item.value, 0))) throw new Error('Input total must be a finite number.');
    output = path.resolve(output);
    if (fs.existsSync(output)) throw new Error(`Output already exists; choose a new directory: ${output}`);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.mkdirSync(output); // no overwrite of another run
    const compiled = compileFiles({
        files: {'workflow.ts': path.join(__dirname, 'workflow.ts')},
        entries: [{file: 'workflow.ts', exportName: 'main'}],
        outputDir: path.join(output, 'artifacts')
    });
    createTerminalOutput().info('Local report: Python summary → your review → save. This example does not call AI.\n');
    if (!process.stdin.isTTY) createTerminalOutput().info('Reading results from stdin. For approved choose 1 (Yes) or 2 (No); EOF leaves the task waiting.\n');
    const display = createRunConsole();
    const run = await startRun({
        intent: 'workflow.main', entryFile: compiled.entryFile, workdir: output, runsDir: path.join(output, 'runs'),
        inputs: {items: JSON.stringify(items)}, inputEncoding: 'typed-text-v1', onEvent: display.onEvent,
        populateSnapshot: ({snapshotDir}) => fs.cpSync(compiled.artifactsDir, snapshotDir, {recursive: true}),
        createResources: ({runId, workdir}) => ({
            humanExecutor: createTerminalHuman(),
            executor: createDispatcher({runId, workdir, codeExecutor: createCodeExecutor(workdir)})
        }),
    });
    display.finish(run);
    if (run.status === 'completed') {
        if (display.outputs?.saved) process.stdout.write(`Saved report: ${path.join(output, 'report.md')} (Total: ${display.outputs.total})\n`);
        else process.stdout.write(`${display.outputs?.reason ?? 'Report not saved'}\n`);
    }
    return {...run, outputs: display.outputs};
}

async function main(args) {
    if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') throw new Error('Usage: node examples/local-report/run.cjs --input <items.json> --output <new directory>');
    const result = await runLocalReport({input: args[1], output: args[3]});
    return result.status === 'completed' && result.outputs?.saved ? 0 : 2;
}

if (require.main === module) main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {runLocalReport};

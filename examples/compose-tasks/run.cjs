#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {startRun} = require('@openhilo/runtime/run-service');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const {compileFiles} = require('../lib/compile.cjs');
const {createResources, validateProvider, checkProvider} = require('../lib/resources.cjs');
const {createRunConsole, createTerminalOutput} = require('../lib/console.cjs');

async function main(args) {
    const {values} = parseArgs({args, options: {provider: {type: 'string'}, input: {type: 'string'}, output: {type: 'string'}}});
    validateProvider(values.provider);
    if (!values.input || !values.output) throw new Error('Provide --input <text.json> and --output <new directory>');
    const input = JSON.parse(fs.readFileSync(values.input, 'utf8'));
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('Input requires a nonblank text string');
    const output = path.resolve(values.output);
    if (fs.existsSync(output)) throw new Error('Output already exists; choose a new directory');
    checkProvider(values.provider);
    fs.mkdirSync(output, {recursive: true});
    const compiled = compileFiles({
        files: {'workflow.ts': path.join(__dirname, 'workflow.ts')},
        entries: [{file: 'workflow.ts', exportName: 'main'}], outputDir: path.join(output, 'artifacts')
    });
    const offline = values.provider === 'offline';
    createTerminalOutput().log(offline ? 'Provider: offline — scripted output, no model is called.\n' : 'Provider: Codex — one short text task.\n');
    const display = createRunConsole(undefined, {suspendedMessage: 'No requirements submitted. Nothing was generated or saved. For a resumable host, use the review-report example.'});
    const aiExecutor = offline ? {
        id: 'openhilo.example.scripted', capabilities: ['structured_output', 'workspace'],
        async start(request, host) {
            return createTaskExecution(request, host, async () => ({
                status: 'completed', outputs: {report: `[OFFLINE scripted output]\nFocus: ${request.inputs.focus}\nSource: ${request.inputs.text}\n`}, artifacts: []
            }));
        }
    } : undefined;
    const result = await startRun({
        intent: 'workflow.main', entryFile: compiled.entryFile, workdir: output, runsDir: path.join(output, 'runs'),
        inputs: {text: input.text}, inputEncoding: 'typed-text-v1', onEvent: display.onEvent,
        populateSnapshot: ({snapshotDir}) => fs.cpSync(compiled.artifactsDir, snapshotDir, {recursive: true}),
        createResources: context => createResources(context, {provider: values.provider, aiExecutor})
    });
    display.finish(result);
    if (result.status === 'completed' && display.outputs?.saved) {
        process.stdout.write(`Saved: ${path.join(output, 'summary.md')}\n`);
        return 0;
    }
    return 2;
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message); process.exitCode = 1;
});
module.exports = {main};

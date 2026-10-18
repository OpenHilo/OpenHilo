#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {startRun} = require('@openhilo/runtime/run-service');
const {compileFiles} = require('../lib/compile.cjs');
const {createRunConsole, createTerminalOutput} = require('../lib/console.cjs');
const {createResources, validateProvider, checkProvider} = require('../lib/resources.cjs');

async function main(args) {
    const {values} = parseArgs({
        args,
        options: {
            provider: {type: 'string'},
            input: {type: 'string'},
            output: {type: 'string'},
            'defer-human': {type: 'boolean'}
        }
    });
    validateProvider(values.provider);
    if (!values.input || !values.output) throw new Error('Usage: node examples/review-report/run.cjs --provider codex|offline --input <json> --output <new directory> [--defer-human]');
    const data = JSON.parse(fs.readFileSync(values.input, 'utf8'));
    if (!data || typeof data.topic !== 'string' || !data.topic.trim() || typeof data.notes !== 'string') throw new Error('Input requires a nonblank topic string and a notes string.');
    const output = path.resolve(values.output);
    if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
    const codexVersion = checkProvider(values.provider);
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.mkdirSync(output);
    const compiled = compileFiles({
        files: {
            'workflow.ts': path.join(__dirname, 'workflow.ts'),
            'format.ts': path.join(__dirname, 'format.ts')
        }, entries: [{file: 'workflow.ts', exportName: 'main'}], outputDir: path.join(output, 'artifacts')
    });
    createTerminalOutput().log(values.provider === 'offline' ? 'Provider: offline — scripted example, no model is called.\n' : `Provider: ${codexVersion}; one or two sentences per attempt, at most 3 rounds.\n`);
    const display = createRunConsole();
    const result = await startRun({
        intent: 'workflow.main', entryFile: compiled.entryFile, workdir: output, runsDir: path.join(output, 'runs'),
        inputs: {topic: data.topic, notes: data.notes}, inputEncoding: 'typed-text-v1',
        receipt: {example: 'review-report', provider: values.provider, codexVersion}, onEvent: display.onEvent,
        populateSnapshot: ({snapshotDir}) => fs.cpSync(compiled.artifactsDir, snapshotDir, {recursive: true}),
        createResources: context => createResources(context, {
            provider: values.provider,
            deferHuman: values['defer-human']
        }),
    });
    display.finish(result);
    if (result.status === 'completed') process.stdout.write(`${display.outputs.reason}${display.outputs.saved ? ': ' + path.join(output, 'report.md') : ''}\n`);
    if (result.status === 'suspended') process.stdout.write(`Continue with node examples/review-report/resume.cjs --run-dir ${JSON.stringify(result.runDir)} --provider ${values.provider}\n`);
    return result.status === 'completed' && display.outputs?.saved ? 0 : 2;
}

if (require.main === module) main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {main};

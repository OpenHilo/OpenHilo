#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {startRun} = require('@openhilo/runtime/run-service');
const {compileFiles} = require('../lib/compile.cjs');
const {checkProvider} = require('../lib/resources.cjs');
const {createTerminalOutput} = require('../lib/console.cjs');
const {documentResources, documentDisplay, finish, exitCode} = require('./host.cjs');

async function runDocumentReview({input, output, deferHuman = false, aiExecutor}) {
    if (!input || !output) throw new Error('Provide --input <UTF-8 brief.md> and --output <new directory>');
    const stat = fs.statSync(input);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Brief must be a UTF-8 file of at most 64 KiB');
    const brief = fs.readFileSync(input);
    if (!new TextDecoder('utf-8', {fatal: true}).decode(brief).trim()) throw new Error('Brief must not be empty');
    output = path.resolve(output);
    if (fs.existsSync(output)) throw new Error('Output already exists; choose a new directory');
    const version = aiExecutor ? 'injected example test adapter' : checkProvider('codex');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.mkdirSync(output); // atomically claim a new output directory
    const workdir = path.join(output, 'workspace');
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, 'brief.md'), brief, {flag: 'wx'});
    fs.cpSync(path.join(__dirname, 'references'), path.join(workdir, 'references'), {recursive: true});
    const compiled = compileFiles({
        files: {'workflow.ts': path.join(__dirname, 'workflow.ts')},
        entries: [{file: 'workflow.ts', exportName: 'main'}], outputDir: path.join(output, 'artifacts')
    });
    createTerminalOutput().log(`Provider: ${version}. AI edits files in ${workdir}; at most one draft and two revisions.\n`);
    const display = documentDisplay();
    const run = await startRun({
        intent: 'workflow.main', entryFile: compiled.entryFile, workdir,
        runsDir: path.join(output, 'runs'), inputs: {brief: 'brief.md', references: 'references'}, inputEncoding: 'typed-text-v1',
        receipt: {example: 'document-review', provider: 'codex', codexVersion: aiExecutor ? null : version},
        onEvent: display.onEvent,
        populateSnapshot: ({snapshotDir}) => fs.cpSync(compiled.artifactsDir, snapshotDir, {recursive: true}),
        createResources: context => documentResources(context, {deferHuman, aiExecutor}),
    });
    return finish(run, display, workdir);
}

async function main(args) {
    const {values} = parseArgs({
        args,
        options: {input: {type: 'string'}, output: {type: 'string'}, 'defer-human': {type: 'boolean'}}
    });
    return exitCode(await runDocumentReview({
        input: values.input,
        output: values.output,
        deferHuman: values['defer-human']
    }));
}

if (require.main === module) main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {runDocumentReview, main};

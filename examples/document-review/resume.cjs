#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {resumeRun} = require('@openhilo/runtime/run-service');
const {checkProvider} = require('../lib/resources.cjs');
const {createTerminalOutput} = require('../lib/console.cjs');
const {documentResources, documentDisplay, finish, exitCode} = require('./host.cjs');

async function resumeDocumentReview({runDir, aiExecutor}) {
    if (!runDir) throw new Error('Provide --run-dir from the previous Records output');
    runDir = path.resolve(runDir);
    const record = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    if (record.example !== 'document-review' || record.provider !== 'codex') throw new Error('This is not a Codex document-review run');
    if (!fs.statSync(record.workdir).isDirectory()) throw new Error('Keep the original workspace to resume this run');
    if (!aiExecutor) checkProvider('codex');
    createTerminalOutput().log(`Resuming ${record.run_id} from its original source snapshot and workspace. Completed AI steps are not repeated.\n`);
    const display = documentDisplay();
    const run = await resumeRun({
        runDir, onEvent: display.onEvent,
        createResources: context => documentResources(context, {aiExecutor}),
    });
    return finish(run, display, record.workdir);
}

async function main(args) {
    const {values} = parseArgs({args, options: {'run-dir': {type: 'string'}}});
    return exitCode(await resumeDocumentReview({runDir: values['run-dir']}));
}

if (require.main === module) main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {resumeDocumentReview, main};

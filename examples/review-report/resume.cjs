#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {resumeRun} = require('@openhilo/runtime/run-service');
const {createRunConsole, createTerminalOutput} = require('../lib/console.cjs');
const {createResources, validateProvider, checkProvider} = require('../lib/resources.cjs');

async function main(args) {
    const {values} = parseArgs({args, options: {'run-dir': {type: 'string'}, provider: {type: 'string'}}});
    validateProvider(values.provider);
    if (!values['run-dir']) throw new Error('Provide --run-dir from the previous run output');
    const runDir = path.resolve(values['run-dir']),
        record = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    if (record.example !== 'review-report' || record.provider !== values.provider) throw new Error('Example/provider mismatch: resume with the provider saved in the run receipt.');
    checkProvider(values.provider);
    createTerminalOutput().log(`Resuming ${record.run_id} from its original snapshot; provider ${values.provider}${values.provider === 'offline' ? ' (scripted)' : ''}.\n`);
    const display = createRunConsole();
    const result = await resumeRun({
        runDir,
        onEvent: display.onEvent,
        createResources: context => createResources(context, {provider: values.provider})
    });
    display.finish(result);
    if (result.status === 'completed') process.stdout.write(`${display.outputs.reason}${display.outputs.saved ? ': ' + path.join(record.workdir, 'report.md') : ''}\n`);
    return result.status === 'completed' && display.outputs?.saved ? 0 : 2;
}

if (require.main === module) main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
module.exports = {main};

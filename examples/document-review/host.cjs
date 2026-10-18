// Composition for this file-editing example only; no new execution protocol.
const path = require('node:path');
const {CodexTaskExecutor} = require('@openhilo/ai-codex');
const {createResources} = require('../lib/resources.cjs');
const {createRunConsole} = require('../lib/console.cjs');

function documentResources(context, {deferHuman = false, aiExecutor} = {}) {
    return createResources(context, {
        provider: 'codex', deferHuman,
        aiExecutor: aiExecutor ?? new CodexTaskExecutor({sandbox: 'workspace-write', effort: 'low', timeoutMs: 120000}),
    });
}

function documentDisplay() {
    return createRunConsole(undefined, {suspendedMessage: 'The document already exists on disk. Review is paused; keep the workspace and use resume.cjs with the printed Records path.'});
}

function finish(run, display, workdir) {
    display.finish(run);
    if (run.status === 'completed') {
        process.stdout.write(`${display.outputs.reason}\nDocument: ${path.resolve(workdir, display.outputs.document)}\n`);
        if (display.outputs.finished) process.stdout.write(`Verified ${display.outputs.bytes} bytes; ${display.outputs.revisions} revision(s).\n`);
    }
    return {...run, outputs: display.outputs};
}

const exitCode = result => result.status === 'completed' && result.outputs?.finished ? 0 : 2;
module.exports = {documentResources, documentDisplay, finish, exitCode};

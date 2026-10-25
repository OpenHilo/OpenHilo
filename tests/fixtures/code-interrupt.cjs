const fs = require('node:fs');
const path = require('node:path');
const {startRun} = require('@openhilo/runtime/run-service');
const {createResources} = require('../../examples/lib/resources.cjs');
const root = process.argv[2];
const entryFile = path.join(root, 'interrupt.itt.impl.json');
fs.writeFileSync(entryFile, JSON.stringify({version: 2, entry: 'code', nodes: {
    code: {id: 'code', type: 'call', executor: 'code', lang: 'python',
        script: 'import time\nopen("ready","w").close()\ntime.sleep(.5)\nopen("effect","w").close()',
        outputs: {}, inputsFrom: {}, outputsTo: {}, next: 'END'}
}}));
startRun({intent: 'interrupt', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
    populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile))),
    createResources: context => createResources(context, {provider: 'offline', deferHuman: true}),
}).then(result => console.log('RESULT:' + JSON.stringify({
    ...result, lockExists: fs.existsSync(path.join(result.runDir, 'run.lock')),
    sigintListeners: process.listenerCount('SIGINT'),
}))).catch(error => {console.error(error); process.exitCode = 1;});

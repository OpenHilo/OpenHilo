const fs = require('node:fs');
const path = require('node:path');
const {resumeRun} = require('@openhilo/runtime/run-service');
const [mode, runDir, coordination] = process.argv.slice(2);

if (mode === 'compete') {
    let scheduled = false;
    // Synchronize the first filesystem mutation that claims local ownership.
    // Both the legacy PID write and an atomic coordination mkdir are real calls;
    // this controls scheduling only, never their return values or contents.
    for (const [method, target] of [['writeFileSync', 'run.lock'], ['mkdirSync', 'run.lock.guard']]) {
        const original = fs[method];
        fs[method] = function(file, ...args) {
            if (!scheduled && String(file) === path.join(runDir, target)) {
                scheduled = true;
                process.send({type: 'ready'});
                const deadline = Date.now() + 10000;
                while (!fs.existsSync(path.join(coordination, 'go'))) {
                    if (Date.now() > deadline) throw new Error('Lock scheduling barrier timed out');
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
            }
            return original.call(fs, file, ...args);
        };
    }
}

let finish;
const finished = mode === 'compete' ? new Promise(resolve => {finish = resolve;}) : Promise.resolve();
if (mode === 'compete') process.on('message', message => {if (message === 'finish') finish();});
resumeRun({runDir, createResources: () => ({executor: async () => {
    fs.appendFileSync(path.join(coordination, 'effects.jsonl'), `${process.pid}\n`);
    process.send?.({type: 'effect'});
    await finished;
    return {outputs: {}};
}})}).then(result => {
    if (mode === 'advance') process.stdout.write(JSON.stringify(result));
    process.disconnect?.();
}).catch(error => {
    if (mode === 'compete') process.send({type: 'rejected', error: error.message}, () => process.disconnect());
    else {console.error(error); process.exitCode = 1;}
});

const fs = require('node:fs');
const {resumeRun} = require('@openhilo/runtime/run-service');
(async () => {
    const result = await resumeRun({
        runDir: process.argv[2],
        humanOutput: {ok: 'true'},
        createResources: () => ({
            executor: async () => {
                throw Error('No replay allowed in resume process');
            }
        })
    });
    const events = fs.readFileSync(result.runDir + '/execution.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    console.log(JSON.stringify({
        status: result.status,
        outputs: events.find(e => e.event === 'run_complete')?.outputs
    }));
})().catch(e => {
    console.error(e);
    process.exitCode = 1;
});

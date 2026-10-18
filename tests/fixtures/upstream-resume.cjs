// Exactly one resume per fresh process. A replay of the pre-child effect fails.
const {resumeRun} = require('@openhilo/runtime/run-service');
(async () => {
    const result = await resumeRun({
        runDir: process.argv[2], humanOutput: {},
        createResources: () => ({
            executor: async () => {
                throw new Error('Completed side effect replayed after recovery');
            }
        }),
    });
    process.stdout.write(JSON.stringify(result));
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

const {resumeRun} = require('@openhilo/runtime/run-service');
resumeRun({
    runDir: process.argv[2], humanOutput: {value: '7'}, createResources: () => ({
        executor: async () => {
            throw new Error('Unexpected external effect');
        }
    })
}).then(result => process.stdout.write(JSON.stringify(result))).catch(error => {
    console.error(error);
    process.exitCode = 1;
});

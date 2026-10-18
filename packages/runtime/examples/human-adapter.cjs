// A third-party integration using public contracts only. No server, UI or AI calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {startRun} = require('@openhilo/runtime/run-service');
const {currentHumanTask} = require('@openhilo/runtime/human-tasks');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'human-adapter-example-'));
    try {
        const entryFile = path.join(root, 'review.itt.impl.json');
        fs.writeFileSync(entryFile, JSON.stringify({
            version: 2, entry: 'review', outputs: {approved: 'approved'}, nodes: {
                review: {
                    id: 'review',
                    type: 'call',
                    executor: 'human',
                    intent: 'Approve the prepared report',
                    inputsFrom: {},
                    outputsTo: {approved: 'approved'},
                    outputs: {approved: 'boolean'},
                    next: 'END'
                },
            }
        }));
        let runDir;
        const result = await startRun({
            intent: 'review', entryFile, inputs: {}, workdir: root, runsDir: path.join(root, 'runs'),
            onRunCreated(_id, dir) {
                runDir = dir;
            },
            populateSnapshot({snapshotDir}) {
                fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
            },
            createResources: () => ({
                executor: async () => {
                    throw new Error('No leaf executor expected');
                }
            }),
            humanExecutor: {
                id: 'example.inbox', async present(task, host) {
                    assert.equal(currentHumanTask(runDir).taskId, task.taskId);
                    // Replace this offline inbox answer with your own UI/transport.
                    const submission = {
                        taskId: task.taskId,
                        submissionId: 'inbox-message-1',
                        outputs: {approved: 'true'}
                    };
                    assert.equal((await host.submit(submission)).status, 'accepted');
                    assert.equal((await host.submit(submission)).status, 'duplicate');
                }
            },
        });
        assert.equal(result.status, 'completed');
        console.log('Custom human adapter completed with a durable, idempotent result.');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

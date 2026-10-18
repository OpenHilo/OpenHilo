// Offline example: public runtime + a fake task executor. No SDK, credentials or personal data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    ExecutionEngine,
    EvalEngine,
    Rehydrator,
    RunManager,
    HumanSuspendedError,
    dispatchAiTask,
    IttValidator
} = require('@openhilo/runtime');
const {createTaskExecution} = require('@openhilo/ai-contracts');

async function runExample() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo-runtime-example-'));
    const evaluator = new EvalEngine();
    let aiCalls = 0;
    try {
        const manager = RunManager.create({runsDir: temp, intent: 'main', workdir: temp});
        const snapshotDir = path.join(manager.runDir, '.snapshot');
        const workflow = {
            version: '2.0', entry: 'draft', inputs: {}, outputs: {answer: 'answer'},
            nodes: {
                draft: {
                    id: 'draft',
                    type: 'call',
                    executor: 'ai',
                    intent: 'Draft a short answer',
                    inputsFrom: {},
                    outputsTo: {text: 'draft'},
                    outputs: {text: 'text'},
                    next: 'review'
                },
                review: {
                    id: 'review',
                    type: 'call',
                    executor: 'human',
                    intent: 'Review the draft',
                    inputsFrom: {draft: '$draft'},
                    outputsTo: {approved: 'approved'},
                    outputs: {approved: 'boolean'},
                    next: 'finish'
                },
                finish: {
                    id: 'finish',
                    type: 'assign',
                    assignments: [{var: 'answer', expr: 'approved ? draft : "rejected"'}],
                    next: 'END'
                },
            },
        };
        const validation = new IttValidator().validate(workflow);
        if (validation.errors.length) throw new Error(validation.errors.join('\n'));
        fs.writeFileSync(path.join(snapshotDir, 'main.itt.impl.json'), JSON.stringify(workflow));
        const fake = {
            id: 'example.offline', capabilities: ['structured_output', 'workspace'],
            async start(request, host) {
                aiCalls++;
                return createTaskExecution(request, host, async () => ({
                    status: 'completed',
                    outputs: {text: 'Independent runtime works'},
                    artifacts: []
                }));
            },
        };
        const options = {
            runId: manager.runId, runDir: manager.runDir, workdir: temp, snapshotDir,
            intentName: 'main', inputs: {}, evalEngine: evaluator, runManager: manager,
            humanMode: 'suspend',
            executor: (node, inputs, context) => dispatchAiTask(node, inputs, {
                workdir: temp,
                aiExecutor: fake
            }, fake, context?.extensions),
        };
        try {
            await new ExecutionEngine(options).run();
            throw new Error('Expected a human suspension');
        } catch (error) {
            if (!(error instanceof HumanSuspendedError)) throw error;
        }
        const waiting = new Rehydrator(manager.runDir).rehydrate();
        if (waiting.kind !== 'suspended_no_output') throw new Error('Missing pending human task');
        const resumed = new Rehydrator(manager.runDir).rehydrate({approved: 'true'});
        if (resumed.kind !== 'ok') throw new Error('Missing recoverable state');
        const outputs = await new ExecutionEngine({
            ...options,
            resumeFrom: resumed,
            pendingHumanOutput: resumed.pendingHumanOutput
        }).run();
        const events = fs.readFileSync(path.join(manager.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        return {
            outputs,
            aiCalls,
            events: events.map(event => event.event),
            status: JSON.parse(fs.readFileSync(path.join(manager.runDir, 'run.json'), 'utf8')).status
        };
    } finally {
        await evaluator.stop();
        fs.rmSync(temp, {recursive: true, force: true});
    }
}

module.exports = {runExample};
if (require.main === module) runExample().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createCodeExecutor} = require('@openhilo/code-local');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const files = {
    'main.ts': `import { finish } from './finish';
declare function draft_by_ai(role: string, prompt: string, round: number): Promise<{text: string}>;
declare function review_by_human(prompt: string, text: string): Promise<{approved: boolean}>;
declare function forbidden_by_code(lang:string,script:string): Promise<{exit_code:number}>;
export async function main(): Promise<{text:string; rounds:number}> {
  let round = 0;
  while (round < 2) {
    round += 1;
    const draft = await draft_by_ai('writer', 'Return a short draft', round);
    const answer = await review_by_human('Approve?', draft.text);
    if (answer.approved) {
      const formatted = await finish(draft.text);
      return {text:formatted.text,rounds:round};
    }
  }
  await forbidden_by_code('bash','touch WRONG_BRANCH');
  return {text:'unapproved',rounds:round};
}`,
    'finish.ts': `export async function finish(text:string): Promise<{text:string}> { return {text: 'Reviewed: '+text}; }`,
};
for (const adapter of ['third-party-A', 'third-party-B']) test(`E3/E11 two-round composed journey with explicit ${adapter} selects only the approved branch`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhilo composed '));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const compiled = compileProgram({files, entries: [{file: 'main.ts', exportName: 'main'}]});
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    const artifacts = path.join(dir, 'artifacts');
    fs.mkdirSync(artifacts);
    for (const artifact of compiled.artifacts) fs.writeFileSync(path.join(artifacts, `${artifact.id}.itt.impl.json`), JSON.stringify(artifact.implementation));
    let calls = 0, reviews = 0, outputs;
    const seen = [];
    const run = await startRun({
        intent: 'main.main',
        entryFile: path.join(artifacts, 'main.main.itt.impl.json'),
        workdir: dir,
        runsDir: path.join(dir, 'runs'),
        inputs: {},
        populateSnapshot: ({snapshotDir}) => fs.cpSync(artifacts, snapshotDir, {recursive: true}),
        onEvent: e => {
            if (e.event === 'run_complete') outputs = e.outputs;
        },
        createResources: ({runId, workdir}) => ({
            executor: createDispatcher({
                runId,
                workdir,
                codeExecutor: createCodeExecutor(workdir),
                aiExecutor: {
                    id: adapter, capabilities: ['workspace', 'structured_output'], async start(request, host) {
                        calls++;
                        seen.push(request.inputs.round);
                        return createTaskExecution(request, host, async () => ({
                            status: 'completed',
                            outputs: {text: `${adapter} round ${calls}`},
                            artifacts: []
                        }));
                    }
                }
            }),
            humanExecutor: {
                id: 'test-human', async present(request, host) {
                    reviews++;
                    await host.submit({
                        taskId: request.taskId,
                        submissionId: `review-${reviews}`,
                        outputs: {approved: String(reviews === 2)}
                    });
                }
            },
        }),
    });
    assert.equal(run.status, 'completed');
    assert.equal(calls, 2);
    assert.equal(reviews, 2);
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(outputs, {text: `Reviewed: ${adapter} round 2`, rounds: 2});
    assert.equal(fs.existsSync(path.join(dir, 'WRONG_BRANCH')), false);
});

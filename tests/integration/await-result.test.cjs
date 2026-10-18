const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {compileProgram} = require('@openhilo/compiler');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');

for (const confirmed of [true, false]) test(`awaited human result keeps object shape after resume (${confirmed})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'await-object-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const source = `declare function confirm_by_human(prompt: string): Promise<{ confirmed: boolean; label: string }>;
export async function main(): Promise<{ greeting: string }> {
  const confirmation = await confirm_by_human('Continue?');
  if (confirmation.confirmed) { return { greeting: confirmation.label }; }
  else { return { greeting: 'declined' }; }
}`;
    const compiled = compileProgram({files: {'main.ts': source}, entries: [{file: 'main.ts', exportName: 'main'}]});
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    const entryFile = path.join(root, 'main.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify(compiled.artifacts.find(a => a.id === 'main.main').implementation));
    const createResources = () => ({
        executor: async () => {
            throw Error('No external executor should run');
        }
    });
    const run = await startRun({
        intent: 'main.main',
        entryFile,
        workdir: root,
        runsDir: path.join(root, 'runs'),
        inputs: {},
        humanMode: 'suspend',
        createResources,
        populateSnapshot: ({snapshotDir}) => fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)))
    });
    assert.equal(run.status, 'suspended');
    const resumed = await resumeRun({
        runDir: run.runDir,
        humanOutput: {confirmed: String(confirmed), label: '小明，你好！'},
        createResources
    });
    assert.equal(resumed.status, 'completed');
    const events = fs.readFileSync(path.join(run.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.find(e => e.event === 'run_complete').outputs.greeting, confirmed ? '小明，你好！' : 'declined');
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createCodeExecutor} = require('@openhilo/code-local');
const compile = source => {
    const r = compileProgram({files: {'p.ts': source}, entries: [{file: 'p.ts', exportName: 'main'}]});
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    return r;
};

async function execute(t, source, inputs = {}) {
    const r = compile(source), root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-file-boundary-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'p.main.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify(r.artifacts.find(a => a.id === 'p.main').implementation));
    let effects = 0;
    let run = await startRun({
        intent: 'p.main',
        entryFile,
        workdir: root,
        runsDir: path.join(root, 'runs'),
        inputs,
        inputEncoding: 'typed-text-v1',
        populateSnapshot({snapshotDir}) {
            for (const a of r.artifacts) fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.impl.json'), JSON.stringify(a.implementation));
        },
        createResources: ({workdir, runId}) => {
            const executor = createDispatcher({runId, workdir, codeExecutor: createCodeExecutor(workdir)});
            return {
                executor: async (...args) => {
                    effects++;
                    return executor(...args);
                }
            };
        }
    });
    assert.equal(run.status, 'suspended');
    const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/upstream-resume.cjs'), run.runDir], {
        encoding: 'utf8',
        timeout: 30000
    });
    assert.equal(child.status, 0, child.stderr);
    run = JSON.parse(child.stdout);
    assert.equal(run.status, 'completed');
    const events = fs.readFileSync(path.join(run.runDir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    return {events, effects, root, output: events.find(e => e.event === 'run_complete').outputs};
}

test('real Code file output is a TS path, reusable by Code, with metadata retained through recovery', async t => {
    const writeScript = 'printf data > report.txt\nreport=report.txt', readScript = 'content=$(cat "$report")';
    const r = await execute(t, `type FilePath=string;declare function make_by_code(lang:string,script:string):Promise<{report:FilePath}>;declare function read_by_code(lang:string,script:string,inputs?:object):Promise<{content:string}>;declare function pause_by_human(prompt:string):Promise<{}>;export async function main():Promise<{value:unknown}>{const {report}=await make_by_code("bash",${JSON.stringify(writeScript)});const {content}=await read_by_code("bash",${JSON.stringify(readScript)},{report});await pause_by_human("Continue");return {value:[typeof report,report,content]};}`);
    assert.deepEqual(r.output, {value: ['string', 'report.txt', 'data']});
    assert.equal(r.effects, 2);
    assert.equal(fs.readFileSync(path.join(r.root, 'report.txt'), 'utf8'), 'data');
    assert.ok(r.events.some(e => e.event === 'node_success' && e.outputs?.report?.type === 'file_ref'));
});
test('declared file entry input projects only its own field; same-shaped JSON retains identity', async t => {
    const ref = {type: 'file_ref', path: 'report.txt', hash: 'h', mtime: 1};
    const r = await execute(t, `type FilePath=string;declare function pause_by_human(prompt:string):Promise<{}>;export async function child(file:FilePath,data:object):Promise<{value:unknown}>{await pause_by_human("Continue");return {value:[typeof file,file,typeof data,data]};}export async function main(file:FilePath,data:object):Promise<{value:unknown}>{const r=await child(file,data);return r;}`, {
        file: 'report.txt',
        data: JSON.stringify(ref)
    });
    assert.deepEqual(r.output, {value: ['string', 'report.txt', 'object', ref]});
    assert.equal(r.effects, 0);
});

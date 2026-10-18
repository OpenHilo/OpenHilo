const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const records = [];
const cases = [
    ['compact highly shared graph', 'let data={n:1};for(let i=0;i<28;i++){data={left:data,right:data};}/*pause*/return {value:data.left===data.right};'],
    ['assignment identity', 'const a={n:1};const b=a;/*pause*/Object.assign(b,{n:3});return {value:[a===b,a.n]};'],
    ['equal objects remain distinct', 'const a={n:1};const b={n:1};/*pause*/Object.assign(b,{n:2});return {value:[a===b,a.n,b.n]};'],
    ['nested shared graph', 'const leaf={n:1};const a={left:leaf,right:[leaf]};const b={deep:a};/*pause*/Object.assign(b.deep.right[0],{n:7});return {value:[a.left===a.right[0],a===b.deep,a.left.n]};'],
    ['shallow copies share children', 'const a={nested:{n:1}};const b={...a};const c=Object.assign({},a);/*pause*/Object.assign(c.nested,{n:4});return {value:[a===b,b.nested===a.nested,a.nested.n]};'],
    ['array destructuring and item identity', 'const a={n:1};const rows=[[a,a]];for(const [x,y] of rows){/*pause*/Object.assign(x,{n:5});if(x!==y)return {value:0};}return {value:a.n};'],
    ['foreach live append', 'const rows=[{n:1}];let total=0;for(const item of rows){/*pause*/total+=item.n;if(rows.length===1)rows.push({n:2});}return {value:total};'],
    ['foreach live shrink', 'const rows=[1,2,3];let total=0;for(const item of rows){/*pause*/total+=item;rows.splice(1);}return {value:total};'],
    ['foreach rebinding retains original iterator', 'let rows=[{n:1},{n:2}];const original=rows;let total=0;for(const item of rows){rows=[{n:100}];/*pause*/Object.assign(item,{n:item.n+1});total+=item.n;}return {value:[total,original[1].n,rows[0].n]};'],
    ['child parameters and returns share identity', 'const a={n:1};const {same}=await child(a,a);/*pause*/Object.assign(same,{n:9});return {value:[a.n,same===a]};', 'export async function child(a:object,b:object):Promise<{same:object}>{/*pause*/Object.assign(b,{n:4});return {same:a};}'],
    ['nested child scopes and parent aliases', 'const a={n:1};const box={a};const {value}=await child(a,box);return {value:[value,a.n,box.a===a]};', 'export async function child(a:object,box:object):Promise<{value:number}>{const alias=box.a;for(const item of [alias]){/*pause*/Object.assign(item,{n:6});}return {value:a.n};}'],
    ['child-created returned aliases', 'const {a,b}=await child();/*pause*/Object.assign(b,{n:8});return {value:[a===b,a.n]};', 'export async function child():Promise<{a:object;b:object}>{const a={n:1};/*pause*/return {a,b:a};}'],
    ['shadowing and escaped block reference', 'let saved={n:0};const x={n:1};{const x={n:2};saved=x;/*pause*/Object.assign(x,{n:3});}/*pause*/return {value:[saved===x,saved.n,x.n]};'],
    ['array replacement preserves other aliases', 'const a={n:1};const items=[a,a];/*pause*/items.splice(0,1,{n:9});/*pause*/Object.assign(a,{n:5});return {value:[items[0]===a,items[1]===a,items[1].n]};'],
];
const declarations = 'declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;';

function source(body, helper = '', pauses = true) {
    return declarations + '\n' + helper + '\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");' + body + '}';
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, body, helper] of cases) test('reference graph: ' + name, {timeout: 60000}, async t => {
    const raw = source(body, helper);
    const nativeCode = ts.transpile(raw.replaceAll('/*pause*/', ''), {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
    });
    const context = {
        exports: {},
        checkpoint_by_human: async () => ({ok: true}),
        once_by_code: async () => ({ok: true})
    };
    vm.runInNewContext(nativeCode, context, {timeout: 1000});
    const native = JSON.parse(JSON.stringify(await context.exports.main()));
    const record = {name, native, modes: []};
    records.push(record);
    for (const mode of ['continuous', 'inline-human', 'new-process']) {
        const compiled = compileProgram({
            files: {'probe.ts': raw.replaceAll('/*pause*/', mode === 'continuous' ? '' : 'await checkpoint_by_human("Continue");')},
            entries: [{file: 'probe.ts', exportName: 'main'}]
        });
        assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-references-'));
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const entryFile = path.join(root, 'probe.main.itt.impl.json');
        fs.writeFileSync(entryFile, JSON.stringify(compiled.artifacts.find(a => a.id === 'probe.main').implementation));
        let effects = 0, presentations = 0;
        let run = await startRun({
            intent: 'probe.main', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
            populateSnapshot({snapshotDir}) {
                for (const a of compiled.artifacts) {
                    fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.impl.json'), JSON.stringify(a.implementation));
                    fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.json'), JSON.stringify(a.declaration));
                }
            },
            createResources: () => ({
                executor: async () => {
                    assert.equal(++effects, 1);
                    return {outputs: {ok: true}};
                }
            }),
            ...(mode === 'inline-human' ? {
                humanExecutor: {
                    id: 'inline', async present(task, ctx) {
                        presentations++;
                        assert.equal((await ctx.submit({
                            taskId: task.taskId,
                            submissionId: 'answer-' + presentations,
                            outputs: {}
                        })).status, 'accepted');
                    }
                }
            } : {}),
        });
        let resumes = 0;
        while (mode === 'new-process' && run.status === 'suspended') {
            assert.ok(++resumes <= 12, 'finite fixture; never retry failed effects');
            const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/upstream-resume.cjs'), run.runDir], {
                encoding: 'utf8',
                timeout: 30000
            });
            assert.equal(child.status, 0, child.stderr);
            run = JSON.parse(child.stdout);
        }
        assert.equal(run.status, 'completed', mode + ': ' + JSON.stringify(events(run.runDir).slice(-3)));
        assert.deepEqual(events(run.runDir).find(e => e.event === 'run_complete').outputs, native, mode);
        assert.equal(effects, 1);
        if (mode === 'new-process') assert.ok(resumes > 0);
        if (mode === 'inline-human') assert.ok(presentations > 0);
        record.modes.push({mode, resumes, presentations, status: 'passed'});
    }
});
after(() => {
    if (process.env.HILO_REFERENCE_REPORT) fs.writeFileSync(process.env.HILO_REFERENCE_REPORT, JSON.stringify({
        node: process.version,
        records
    }, null, 2) + '\n');
});

const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const records = [];
const cases = [
    ['string scalar increment', 'let x:any="2";x++;/*pause*/return {value:[x,typeof x]};'],
    ['string scalar decrement', 'let x:any="4";--x;/*pause*/return {value:[x,typeof x]};'],
    ['null and boolean scalar update', 'let a:any=null;let b:any=true;++a;b++;/*pause*/return {value:[a,b]};'],
    ['scalar loop step coercion', 'let n:any="0";let sum=0;for(;n<3;n++){sum+=Number(n);/*pause*/}return {value:[n,sum]};'],
    ['scalar logical short circuit', 'let a=0;let b=1;const seen=[];a&&=(seen.push("bad"),2);b||=(seen.push("bad"),3);a||=(seen.push("a"),4);/*pause*/return {value:[a,b,seen]};'],
    ['safe intrinsic and callbacks', 'const values=Array.from({length:3},(_,i)=>i+1);const total=values.reduce((a,b)=>a+b,0);/*pause*/return {value:[total,Array.isArray(values),Object.keys({x:1}),Math.max(...values)]};'],
    ['computed method receiver', 'const method="slice";const a=[1,2,3];/*pause*/return {value:a[method](1)};'],
    ['computed key and optional short circuit', 'const seen=[];const rows=[{value:7}];const names=["value"];const idx=0;const nil:any=null;const absent=nil?.[(()=>{seen.push("bad");return 0;})()]??null;/*pause*/const value=rows[(()=>{seen.push("once");return 0;})()][names[idx]];return {value:[value,absent,seen]};'],
    ['typed callback destructuring', 'const rows=[{n:2}];/*pause*/return {value:rows.map(({n:value}:{n:number})=>value*2)};'],
    ['callback local shadowing', 'const values=[1].map(undefined=>{const NaN=2;const Infinity=3;return undefined+NaN+Infinity;});/*pause*/return {value:values};'],
    ['untyped renamed callback binding', `const values=JSON.parse('[{"x":1}]').map(({x:n})=>n);/*pause*/return {value:values};`],
    ['parenthesized callback', 'const values=[1].map(((x)=>x+1));/*pause*/return {value:values};'],
    ['typed parenthesized callback', 'const values=[1].map((((x:number)=>x+1) as (x:number)=>number));/*pause*/return {value:values};'],
    ['callback locals and assignments', 'const values=[1].map(x=>{let n=x;let m=2;({n}={n:3});[n,m]=[m,n];n++;const obj={n,m};return obj;});/*pause*/return {value:values};'],
    ['optional stages and calls', 'const a:any=null;const b={n:{v:3}};const absent=a?.n?.v??null;const called=a?.map(x=>x)??null;/*pause*/return {value:[absent,called,b?.n?.v]};'],
    ['transient undefined with default', 'const [x=3]=[undefined];const y=({}).missing??null;/*pause*/return {value:[x,y]};'],
];
const declarations = 'declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;';

function source(body, helper = '', pauses = true) {
    return declarations + '\n' + helper + '\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");' + body + '}';
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, body, helper] of cases) test('support boundary: ' + name, {timeout: 60000}, async t => {
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
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-boundary-'));
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
    if (process.env.HILO_BOUNDARY_REPORT) fs.writeFileSync(process.env.HILO_BOUNDARY_REPORT, JSON.stringify({
        node: process.version,
        records
    }, null, 2) + '\n');
});

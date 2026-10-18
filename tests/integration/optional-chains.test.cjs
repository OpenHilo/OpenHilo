const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const records = [];
const cases = [
    ['null base continues property chain', 'const a:any=null;/*pause*/return {value:a?.b.c??null};'],
    ['undefined base continues chain', 'const a={};/*pause*/return {value:a.missing?.b.c??null};'],
    ['present property chain', 'const a={b:{c:7}};/*pause*/return {value:a?.b.c};'],
    ['mixed computed chain', 'const a={b:[{c:7}]};const key="b";/*pause*/return {value:a?.[key][0].c};'],
    ['skip computed keys and arguments', 'const a:any=null;const seen=[];/*pause*/const x=a?.[seen.push("key")].slice(seen.push("arg"))??null;return {value:[x,seen]};'],
    ['optional method keeps receiver', 'const a=[1,2,3];/*pause*/return {value:[a.slice?.(1),a?.slice(1),a?.slice?.(1)]};'],
    ['computed optional method receiver', 'const a=[1,2,3];const method="slice";/*pause*/return {value:a?.[method]?.(1).join("-")};'],
    ['receiver evaluated once with mutation', 'const seen=[];const rows=[[1]];/*pause*/const x=rows[(seen.push("receiver"),0)]?.push?.((seen.push("arg"),2));return {value:[x,rows,seen]};'],
    ['optional absent call skips arguments', 'const a={};const seen=[];/*pause*/return {value:[a.missing?.(seen.push("bad"))??null,seen]};'],
    ['optional call null continuation', 'const a={};/*pause*/return {value:a.missing?.().x.y??null};'],
    ['optional identifier call', 'const f:any=null;/*pause*/return {value:f?.(1).x??null};'],
    ['immediate optional call', '/*pause*/return {value:(()=>({n:4}))?.().n};'],
    ['nested calls and callback', 'const rows=[[1,2],null,[3]];/*pause*/return {value:rows.map(a=>a?.slice?.(0).map(x=>({n:x}))[0]?.n??null)};'],
    ['falsy is not nullish', 'const a=0;const b=false;const c="";/*pause*/return {value:[a?.toString(),b?.toString(),c?.length]};'],
    ['non null assertion preserves chain', 'const a:any=null;/*pause*/return {value:[a?.b!.c??null,a?.b!.slice?.(0).length??null]};'],
    ['typed parentheses retain explicit optional step', 'const a:any=null;/*pause*/return {value:(a?.b as {c:number}|undefined)?.c??null};'],
    ['parenthesized optional call receiver', 'const a=[1,2];/*pause*/return {value:[(a?.slice)?.(1),(a?.slice)(1)]};'],
    ['mixed independent chains', 'const a:any=null;const b={x:[3]};/*pause*/return {value:[a?.x.y??b?.x[0],(a?.x??b.x)?.slice?.(0)[0]]};'],
    ['temporary name hygiene', 'const _a={b:[4]};const _b=8;const __itt_expression=9;/*pause*/return {value:[_a?.b.slice?.(0)[0],_b,__itt_expression]};'],
    ['reference alias before and after recovery', 'const a={b:{n:1}};const alias=a?.b;/*pause*/alias.n=2;return {value:[alias===a?.b,a?.b.n]};'],
    ['repeated checkpoints and chain mutation', 'const rows=[[1]];const seen=[];for(let i=0;i<2;i++){/*pause*/seen.push(rows?.[0].push?.(i));}return {value:[seen,rows]};'],
    ['short circuit does not skip outer operand', 'const a:any=null;const seen=[];/*pause*/return {value:[Number(a?.b.c??0)+(seen.push("outer"),2),seen]};'],
    ['skipped reflection key is not checked', 'const a:any=null;const key="constructor";/*pause*/return {value:a?.[key].x??null};'],
    ['every nullish step chooses only its own fallback', 'const a={b:null};const b:any=null;/*pause*/return {value:[a?.b?.c??1,b?.c.d??2,a?.missing?.().x??3]};'],
    ['allowed optional intrinsics', '/*pause*/return {value:[Math?.max?.(2,5),String?.(3),Array?.isArray?.([])]};'],
    ['optional chain in branches and loop condition', 'const a={rows:[1,2]};let sum=0;for(let i=0;i<(a?.rows.length??0);i++){/*pause*/if(a?.rows[i]){sum+=a?.rows[i];}}return {value:sum};'],
    ['optional chain in destructuring defaults', 'const a={b:{n:5}};/*pause*/const {x=a?.b.n}={};return {value:x};'],
    ['member assignment from optional chain', 'const a={b:{n:5}};const result={n:0};/*pause*/result.n=a?.b.n;return {value:result};'],
    ['callback member update remains a write', 'const rows=[{n:1}];const source={n:2};/*pause*/return {value:rows.map(x=>{x.n=source?.n;return x?.n;})};'],
    ['recursive callback optional call', '/*pause*/return {value:[3].map(function f(n){return n?f?.(n-1)+1:0;})};'],
    ['expression-local alias identity', 'const a={b:{n:1}};/*pause*/return {value:[a?.b===a.b,[a?.b,a.b][0]===a.b]};'],
    ['optional method spread arguments', 'const a=[1];const values=[2,3];/*pause*/return {value:[a?.push?.(...values),a]};'],
    ['nested chain inside key and argument', 'const a={b:[1,2]};const config={key:"b",start:1};/*pause*/return {value:a?.[config?.key].slice?.(config?.start)[0]};'],
    ['parenthesized chain base may be written', 'const a={b:{n:1}};/*pause*/(a?.b).n=2;return {value:a};'],
    ['parenthesized callback chain base may be written', 'const a=[{b:{n:1}}];/*pause*/return {value:a.map(x=>{(x?.b).n=2;return x;})};'],
    ['typed optional method receiver', 'const a=[1,2];/*pause*/return {value:(a?.slice as any)?.(1)};'],
    ['parenthesized chain write null base throws', 'const a:any=null;/*pause*/(a?.b).n=2;return {value:1};', 'TypeError'],
    ['argument reassigns callback receiver', '/*pause*/return {value:[0].map(()=>{let a=[1,2];const result=a?.slice?.((a=[9],1));return [result,a];})};'],
    ['computed key reassigns callback receiver', '/*pause*/return {value:[0].map(()=>{let a=[1,2];const result=a?.[(a=[9],"slice")]?.(1);return [result,a];})};'],
    ['callback defaults and temporary shadowing', 'const a={b:[4]};/*pause*/return {value:[{}].map(({n=a?.b.slice?.(0)[0]})=>{const _a={x:n};const _b=2;return [_a?.x,_b];})};'],
    ['type assertion and satisfies preserve receiver', 'const a=[1,2];/*pause*/return {value:[(<any>a?.slice)?.(1),(a?.slice satisfies unknown)?.(1)]};'],
    ['non optional null intermediate throws', 'const a={b:null};/*pause*/return {value:a?.b.c};', 'TypeError'],
    ['parentheses end chain', 'const a:any=null;/*pause*/return {value:(a?.b).c};', 'TypeError'],
    ['typed parentheses end chain', 'const a:any=null;/*pause*/return {value:(a?.b as any).c};', 'TypeError'],
    ['present non callable throws', 'const a={m:3};/*pause*/return {value:a.m?.()};', 'TypeError'],
    ['parenthesized non optional call throws', 'const a:any=null;/*pause*/return {value:(a?.slice)(1)};', 'TypeError'],
];
const declarations = 'declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;';

function source(body, helper = '', pauses = true) {
    return declarations + '\n' + helper + '\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");' + body + '}';
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, body, expectedError] of cases) test('optional chains: ' + name, {timeout: 60000}, async t => {
    const raw = source(body);
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
    let native;
    try {
        native = JSON.parse(JSON.stringify(await context.exports.main()));
        assert.equal(expectedError, undefined, 'native JS must throw for this fixture');
    } catch (error) {
        assert.equal(error.name, expectedError);
        native = {error: error.name};
    }
    const record = {name, native, modes: []};
    records.push(record);
    for (const mode of ['continuous', 'inline-human', 'new-process']) {
        const compiled = compileProgram({
            files: {'probe.ts': raw.replaceAll('/*pause*/', mode === 'continuous' ? '' : 'await checkpoint_by_human("Continue");')},
            entries: [{file: 'probe.ts', exportName: 'main'}]
        });
        assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-optional-'));
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
        const log = events(run.runDir);
        if (expectedError) {
            assert.equal(run.status, 'aborted', mode + ': ' + JSON.stringify(log.slice(-3)));
            assert.equal(log.some(e => e.event === 'run_complete'), false);
            assert.match(JSON.stringify(log), /Cannot read|Cannot set|not a function|not callable/);
        } else {
            assert.equal(run.status, 'completed', mode + ': ' + JSON.stringify(log.slice(-3)));
            assert.deepEqual(log.find(e => e.event === 'run_complete').outputs, native, mode);
        }
        assert.equal(effects, 1);
        if (mode === 'new-process') assert.ok(resumes > 0);
        if (mode === 'inline-human') assert.ok(presentations > 0);
        record.modes.push({mode, resumes, presentations, status: 'passed'});
    }
});
after(() => {
    if (process.env.HILO_OPTIONAL_REPORT) fs.writeFileSync(process.env.HILO_OPTIONAL_REPORT, JSON.stringify({
        node: process.version,
        records
    }, null, 2) + '\n');
});

for (const [name, body, diagnostic] of [
    ['function intermediate', 'const a=[];return {value:a?.map.name};', /function value escape/],
    ['function intermediate write', 'const a=[];a?.map.state=7;return {value:1};', null],
    ['dynamic function intermediate', 'const a=[];const key="map";return {value:a?.[key].name};', /function value escape/],
    ['optional method value escape', 'const a=[];return {value:a?.slice};', /function value escape/],
    ['optional function assign target', 'const a=[];return {value:Object.assign(a?.map,{state:7}).state};', /function value escape/],
    ['dynamic reflection', 'const a={};const key="constructor";return {value:a?.[key].name};', /reflection key/],
    ['undefined persistence', 'const a:any=null;const x=a?.b.c;return {value:x};', /JSON-compatible|undefined/],
]) test('optional boundary: ' + name, async t => {
    const raw = source('/*pause*/' + body);
    const compiled = compileProgram({
        files: {'probe.ts': raw.replaceAll('/*pause*/', 'await checkpoint_by_human("Continue");')},
        entries: [{file: 'probe.ts', exportName: 'main'}]
    });
    if (!diagnostic) {
        assert.equal(compiled.ok, false);
        assert.deepEqual(compiled.artifacts, []);
        return;
    }
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    for (const resumed of [false, true]) {
        const c = resumed ? compiled : compileProgram({
            files: {'probe.ts': raw.replaceAll('/*pause*/', '')},
            entries: [{file: 'probe.ts', exportName: 'main'}]
        });
        assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-optional-boundary-'));
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const entryFile = path.join(root, 'probe.main.itt.impl.json');
        fs.writeFileSync(entryFile, JSON.stringify(c.artifacts[0].implementation));
        let effects = 0;
        let run = await startRun({
            intent: 'probe.main', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
            populateSnapshot({snapshotDir}) {
                for (const a of c.artifacts) {
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
        });
        if (resumed) {
            assert.equal(run.status, 'suspended');
            const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/upstream-resume.cjs'), run.runDir], {
                encoding: 'utf8',
                timeout: 30000
            });
            assert.equal(child.status, 0, child.stderr);
            run = JSON.parse(child.stdout);
        }
        assert.equal(run.status, 'aborted', JSON.stringify(events(run.runDir).slice(-3)));
        assert.match(JSON.stringify(events(run.runDir)), diagnostic);
        assert.equal(effects, 1);
    }
});

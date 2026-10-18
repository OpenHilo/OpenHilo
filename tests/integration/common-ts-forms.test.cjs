const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const records = [];
const cases = [
    ['object loop defaults and rest', 'const seen=[];const result=[];for(const {id,name=(seen.push("default"),"anon"),...rest} of [{id:1},{id:2,name:"two",extra:3}]){/*pause*/result.push([id,name,rest]);}return {value:[result,seen]};'],
    ['nested loop patterns', 'const result=[];for(const {row:[id,{name="n"}]} of [{row:[1,{}]},{row:[2,{name:"b"}]}]){/*pause*/result.push([id,name]);}return {value:result};'],
    ['array elisions defaults and rest', 'const result=[];for(const [a,,b=5,...tail] of [[1,2],[3,4,6,7]]){/*pause*/result.push([a,b,tail]);}return {value:result};'],
    ['loop earlier binding default', 'const result=[];for(const [a,b=a+1] of [[1],[4,9]]){/*pause*/result.push([a,b]);}return {value:result};'],
    ['loop rest shallow references', 'const child={n:1};const source=[{child,id:2}];let same=false;for(const {id,...rest} of source){/*pause*/rest.child.n++;same=rest.child===child;}return {value:[same,child.n]};'],
    ['nested loop shadow continue break', 'const id=9;const result=[];for(const {id} of [{id:1},{id:2},{id:3}]){/*pause*/if(id===2){continue;}for(const [id] of [[7],[8]]){result.push(id);break;}if(id===3){break;}}return {value:[id,result]};'],
    ['loop source mutation', 'const rows=[{n:1},{n:2}];const result=[];for(const {n} of rows){/*pause*/result.push(n);if(n===1){rows.push({n:3});}}return {value:result};'],
    ['empty loop patterns', 'let n=0;for(const {} of [{a:1},{a:2}]){/*pause*/n++;}return {value:n};'],
    ['return object variable', 'const result={value:3};/*pause*/return result;'],
    ['return reassigned variable', 'let result={value:1};/*pause*/result={value:2};return result;'],
    ['return wrapped variable', 'const result={value:[1,2]};/*pause*/return ((result as {value:number[]})!);'],
    ['return variable in loop', 'for(const {n} of [{n:3}]){/*pause*/const result={value:n};return result;}const fallback={value:0};return fallback;'],
    ['return parameter and child aliases', 'const child={n:1};const input={value:[child,child]};const output=await pass(input);/*pause*/output.value[0].n++;return {value:[output.value[0]===child,child.n,output.value[0]===output.value[1]]};', 'export async function pass(result:{value:object[]}):Promise<{value:object[]}>{return result;}'],
    ['returned container identity across child pause', 'const input={value:[1]};const output=await pass(input);/*pause*/output.value.push(2);return {value:[input===output,input.value]};', 'export async function pass(result:{value:number[]}):Promise<{value:number[]}>{/*pause*/return result;}'],
    ['wrapped returned literal', '/*pause*/return ({value:2} as {value:number});'],
    ['parenthesized intrinsics', '/*pause*/return {value:[(Math.max)(1,2),((Number))("3"),(JSON.parse)("4")]};'],
    ['static intrinsic member selectors', '/*pause*/return {value:[Math["max"](1,2),JSON[`parse`]("4"),(Array["isArray"])([])]};'],
    ['wrapped intrinsic base and selector', '/*pause*/return {value:[(Math as any)[("max" as const)](1,2),((String as any))(3)]};'],
    ['static callback selector', '/*pause*/return {value:[1,2]["map"](x=>x*2)};'],
    ['wrapped callback target', '/*pause*/return {value:([1,2].map)(x=>x*2)};'],
    ['conversion callback wrappers', '/*pause*/return {value:["1","2"]["map"]((Number))};'],
    ['optional static callback selector', 'const rows=[{n:1}];/*pause*/return {value:rows?.["map"]?.(x=>x?.n)};'],
    ['computed method receiver and once only', 'const seen=[];const rows=[[1,2]];/*pause*/return {value:[(rows[(seen.push("base"),0)]["slice"])((seen.push("arg"),1)),seen]};'],
    ['wrapped workflow invocation', 'const {value}=await ((child as any))(3);/*pause*/const result={value};return result;', 'export async function child(n:number):Promise<{value:number}>{const result={value:n+1};return result;}'],
    ['loop default references outer scope', 'const seed=7;const result=[];for(const {x=seed} of [{}]){/*pause*/result.push(x);}return {value:result};'],
    ['empty array loop pattern', 'let count=0;for(const [] of [[1],[]]){/*pause*/count++;}return {value:count};'],
    ['nested returned container passthrough', 'const input={value:{n:1}};const output=await outer(input);/*pause*/return {value:[output===input,output.value===input.value]};', 'export async function inner(result:{value:object}):Promise<{value:object}>{/*pause*/return result;}export async function outer(result:{value:object}):Promise<{value:object}>{const output=await (inner)(result);return output;}'],
    ['return named fields preserve simultaneous reads', 'const output=await swapped();/*pause*/return {value:output};', 'export async function swapped():Promise<{x:number,y:number}>{let x=1;let y=2;const result={x:y,y:x};/*pause*/return result;}'],
    ['empty result still preserves reference', 'const input={};const output=await empty(input);/*pause*/return {value:input===output};', 'export async function empty(result:object):Promise<{}>{/*pause*/return result;}'],
    ['wrapped constructor and static callback', '/*pause*/return {value:(new (Array)(1,2)[`map`])((n)=>n*3)};'],
    ['combined loop callback and returned alias', 'const rows=[{id:1,values:[2,3]},{id:2,values:[4]}];const result={value:[]};for(const {id,values,...rest} of rows){/*pause*/result.value.push({id,total:(values["reduce"])((sum,n)=>sum+n,0),rest});}return result;'],
];
const declarations = 'declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;';

function source(body, helper = '', pauses = true) {
    return declarations + '\n' + helper + '\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");' + body + '}';
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, body, helper] of cases) test('common TS forms: ' + name, {timeout: 60000}, async t => {
    const expectedError = undefined;
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
            files: {'probe.ts': raw.replaceAll('/*pause*/', mode === 'continuous' ? '' : 'await ((checkpoint_by_human))("Continue");')},
            entries: [{file: 'probe.ts', exportName: 'main'}]
        });
        assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-forms-'));
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
    if (process.env.HILO_FORMS_REPORT) fs.writeFileSync(process.env.HILO_FORMS_REPORT, JSON.stringify({
        node: process.version,
        records
    }, null, 2) + '\n');
});

for (const [name, body, diagnostic] of [
    ['missing return field', 'const result={};return result;', /return.*field|output.*field/i],
    ['extra return field', 'const result={value:1,extra:2};return result;', /return.*field|output.*field/i],
    ['null return variable', 'const result=null;return result;', /return.*object/i],
    ['array return variable', 'const result=[1];return result;', /return.*object/i],
    ['primitive return variable', 'const result=1;return result;', /return.*object/i],
    ['empty object destructures null', 'for(const {} of [null]){}return {value:1};', /null|destructur/i],
    ['loop invalid element', 'for(const [x] of [1]){}return {value:1};', /iterable/i],
    ['loop missing value', 'for(const {x} of [{}]){}return {value:1};', /JSON-compatible|undefined/i],
]) test('common forms boundary: ' + name, async t => {
    const raw = source('/*pause*/' + body);
    const compiled = compileProgram({
        files: {'probe.ts': raw.replaceAll('/*pause*/', 'await ((checkpoint_by_human))("Continue");')},
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
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-forms-boundary-'));
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

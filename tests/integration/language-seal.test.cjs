const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const records = [];
const cases = [
    ['loop branch alias child await', 'const state={items:[],total:0};const alias=state;for(const {n,skip=false} of [{n:1},{n:2,skip:true},{n:3}]){if(skip){continue;}const out=await child(state,n);/*pause*/if(out!==state){return {value:"lost identity"};}if(n===3){break;}}return {value:[state===alias,alias]};', 'export async function child(state:any,n:number):Promise<{items:unknown[],total:number}>{const {total}=state;state.total=total+n;state.items.push(n);/*pause*/return state;}'],
    ['while shadow destructuring optional', 'const state={items:[],slot:{n:0}};const alias=state.slot;let n=0;while(n<3){const {n:before}=alias;{const n=before+1;state.slot.n=n;}/*pause*/state.items.push(state?.slot.n??0);n++;}return {value:[state,alias===state.slot]};'],
    ['for step logical writes and callback', 'const rows=[{n:1},{n:2}];const alias=rows[0];for(let i=0;i<rows.length;i++){rows[i].n*=2;/*pause*/rows[i].label??="ok";}return {value:[rows.map(({n,label})=>({n,label})),alias===rows[0]]};'],
    ['nested await target and return expression', 'const original={result:{value:0}};const holder={current:original};const seen=[];holder.current[(seen.push("key"),"result")]=await child(holder,seen);/*pause*/return true?{value:[original.result,holder.current,seen]}:{value:null};', 'export async function child(holder:any,seen:unknown[]):Promise<{value:number}>{holder.current={result:{value:9}};seen.push("child");/*pause*/return {...{value:4}};}'],
    ['loop rest shallow references and return alias', 'const shared={n:1};const values=[{id:1,shared},{id:2,shared}];let result={value:null};for(const {id,...rest} of values){/*pause*/rest.shared.n+=id;result=await child(rest.shared);}return {value:[shared,result.value===shared,values[0].shared===values[1].shared]};', 'export async function child(item:any):Promise<{value:unknown}>{const out={value:item};/*pause*/return out;}'],
];
const declarations = 'declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;';

function source(body, helper = '', pauses = true) {
    return declarations + '\n' + helper + '\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");' + body + '}';
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, body, helper] of cases) test('sealed composition: ' + name, {timeout: 60000}, async t => {
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
        const pause = mode === 'continuous' ? '' : 'await ((checkpoint_by_human))("Continue");';
        const files = helper ? {
            'probe.ts': source(body, 'import {child} from "./child";').replaceAll('/*pause*/', pause),
            'child.ts': (declarations + helper).replaceAll('/*pause*/', pause)
        } : {'probe.ts': raw.replaceAll('/*pause*/', pause)};
        const compiled = compileProgram({files, entries: [{file: 'probe.ts', exportName: 'main'}]});
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
    if (process.env.HILO_SEAL_REPORT) fs.writeFileSync(process.env.HILO_SEAL_REPORT, JSON.stringify({
        node: process.version,
        records
    }, null, 2) + '\n');
});

for (const [name, body, diagnostic] of [
    ['dynamic nonfinite', 'const x=Number("invalid");return {value:x};', /non-finite|JSON-compatible/i],
    ['dynamic undefined', 'const x={};return {value:x.missing};', /undefined|JSON-compatible/i],
    ['dynamic cycle', 'const x={};x.self=x;return {value:1};', /cycle/i],
    ['dynamic hole', 'const x=[];x[2]=1;return {value:1};', /sparse|array/i],
    ['dynamic negative zero', 'const x=0;return {value:-x};', /negative zero/i],
    ['dynamic reflection', 'const key="con"+"structor";return {value:[][key]};', /reflection/i],
    ['dynamic invalid return', 'const source={value:1,extra:2};return {...source};', /return.*field|output.*field/i],
]) test('await return boundary: ' + name, async t => {
    const raw = source('const result=await bad();await once_by_code("javascript","must-not-run");return result;', 'export async function bad():Promise<{value:unknown}>{/*pause*/' + body + '}');
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
        fs.writeFileSync(entryFile, JSON.stringify(c.artifacts.find(a => a.id === 'probe.main').implementation));
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
        assert.equal(events(run.runDir).some(e => e.event === 'run_complete'), false);
        assert.equal(JSON.stringify(events(run.runDir)).includes('must-not-run'), false, 'caller effect must not be reached after child failure');
        assert.match(JSON.stringify(events(run.runDir)), diagnostic);
        assert.equal(effects, 1);
    }
});

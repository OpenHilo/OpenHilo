const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const records = [];
let memoryEvidence;
// Each case catches a different lowering error: lost mutation, repeated evaluation,
// wrong operator/short circuit, or alias loss at a controlled checkpoint.
const cases = [
    ['member aliases', 'const a={n:1};const b=a;/*pause*/b.n=3;return {value:[a===b,a.n]};'],
    ['nested and array targets', 'const a={n:1};const rows=[a];rows[0].n+=2;rows[1]=a;/*pause*/rows[1].n++;return {value:[rows[0]===rows[1],a.n]};'],
    ['member operator families', 'const x={n:8};x.n-=2;x.n*=3;x.n/=2;x.n%=5;x.n**=2;x.n<<=1;x.n>>=1;x.n>>>=1;x.n|=8;x.n&=14;x.n^=2;++x.n;--x.n;x.n--;x.n++;/*pause*/return {value:x.n};'],
    ['member numeric update coercion', 'const x={n:"2"};x.n++;/*pause*/--x.n;return {value:[x.n,typeof x.n]};'],
    ['member logical short circuit', 'const seen=[];const x={a:1,b:0,c:null};x.a||=(seen.push("bad"),9);x.b&&=(seen.push("bad"),9);x.c??=(seen.push("c"),3);x.a&&=(seen.push("a"),4);x.b||=(seen.push("b"),5);x.c??=(seen.push("bad"),8);/*pause*/return {value:[x,seen]};'],
    ['member base key rhs order', 'const log=[];const x={n:1};(log.push("base"),x)[(log.push("key"),"n")]+=(log.push("rhs"),2);/*pause*/return {value:[x.n,log]};'],
    ['member computed key once', 'const state={index:0};const rows=[1,2];rows[state.index++]+=3;/*pause*/return {value:[rows,state.index]};'],
    ['parenthesized member update', 'const a={n:1};((a.n=3));/*pause*/return {value:a.n};'],
    ['member loop step and continue', 'const state={i:9,total:0};for(state.i=0;state.i<3;state.i++){/*pause*/if(state.i===1)continue;state.total+=state.i;}return {value:state};'],
    ['member child and parent identity', 'const a={n:1};const {same}=await child(a);/*pause*/same.n+=3;return {value:[a.n,same===a]};', 'export async function child(a:object):Promise<{same:object}>{a.n++;/*pause*/return {same:a};}'],
    ['object declaration aliases', 'const a={n:1};const source={left:a,right:a};const {left:first,right}=source;/*pause*/first.n=5;return {value:[first===right,right===a,a.n]};'],
    ['nested pattern defaults and rest', 'const leaf={n:1};const source={box:{leaf},keep:leaf,empty:null};const {box:{leaf:alias},missing=4,empty=8,...rest}=source;/*pause*/alias.n++;return {value:[missing,empty,rest.keep===leaf,rest.keep.n]};'],
    ['array pattern defaults holes rest', 'const a={n:1};const [first,,third=3,...rest]=[a,9,a,a];/*pause*/rest[0].n++;return {value:[first===third,third===rest[0],first.n]};'],
    ['missing default and sequential declaration', 'const [a=2,b=a+1]=[];const {x=4,y=x+1}={};/*pause*/return {value:[a,b,x,y]};'],
    ['array swap assignment', 'let a={n:1};let b={n:2};const old=a;[a,b]=[b,a];/*pause*/b.n=7;return {value:[a.n,b===old,old.n]};'],
    ['object assignment defaults ordering', 'let a=1;let b=9;({x:a=2,y:b=a+3}={});/*pause*/return {value:[a,b]};'],
    ['duplicate assignment target', 'let a=0;[a,a]=[1,2];/*pause*/return {value:a};'],
    ['nested rest assignment', 'const leaf={n:1};let a=null;let b=null;let rest={};({box:[a,b=leaf],...rest}={box:[leaf],other:leaf});/*pause*/a.n++;return {value:[a===b,b===rest.other,leaf.n]};'],
    ['pattern source evaluated once', 'const log=[];const {x,y}=(log.push("source"),{x:1,y:2});/*pause*/return {value:[x,y,log]};'],
    ['pattern default effects order', 'const log=[];const {x=(log.push("x"),1),y=(log.push("y"),2),z=(log.push("bad"),3)}={z:null};/*pause*/return {value:[x,y,z,log]};'],
    ['pattern shadowing', 'let saved={n:0};const x={n:1};{const {value:x}={value:{n:2}};saved=x;/*pause*/x.n++;}/*pause*/return {value:[x.n,saved.n]};'],
    ['pattern literal keys and shorthand', 'const source={"a-b":2,3:4,x:6};const {"a-b":a,3:b,x}=source;/*pause*/return {value:[a,b,x]};'],
    ['patterns empty and trailing holes', 'const seen=[];const {}=(seen.push("object"),{});const [,,]=(seen.push("array"),[1,2]);/*pause*/return {value:seen};'],
    ['pattern loop initialization', 'let total=0;for(let [i,limit]=[0,3];i<limit;i++){/*pause*/total+=i;}return {value:total};'],
    ['awaited nested defaults rest', 'const {box:{leaf},missing=3,...rest}=await child();/*pause*/leaf.n++;return {value:[leaf===rest.other,leaf.n,missing]};', 'export async function child():Promise<{box:object;other:object}>{const leaf={n:1};/*pause*/return {box:{leaf},other:leaf};}'],
    ['awaited pattern then repeated child sharing', 'const a={n:1};const {box:{leaf}}=await child(a);/*pause*/leaf.n=9;return {value:[leaf===a,a.n]};', 'export async function child(a:object):Promise<{box:object}>{const {n}=a;/*pause*/return {box:{leaf:a}};}'],
];
const declarations = 'declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;';

function source(body, helper = '', pauses = true) {
    return declarations + '\n' + helper + '\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");' + body + '}';
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, body, helper] of cases) test('common assignments: ' + name, {timeout: 60000}, async t => {
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
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-assignments-'));
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
    if (process.env.HILO_ASSIGNMENT_REPORT) fs.writeFileSync(process.env.HILO_ASSIGNMENT_REPORT, JSON.stringify({
        node: process.version,
        records,
        memory: memoryEvidence
    }, null, 2) + '\n');
});

// These cases must fail explicitly both before any pause and after a fresh-process
// resume, never delivering the subsequent Human request or successful output.
for (const [name, body, diagnostic] of [
    ['missing declaration value', 'const {missing}={};', /undefined/],
    ['missing assignment value', 'let a=1;[a]=[];', /undefined/],
    ['null object pattern', 'const {x}=null;', /null|destructure/],
    ['null empty pattern', 'const {}=null;', /null|destructure/],
    ['noniterable array pattern', 'const [x]={0:1};', /iterable/],
    ['sparse member write', 'const a=[1];a[3]=2;', /sparse/],
    ['array length holes', 'const a=[1];a.length=3;', /sparse/],
    ['undefined member write', 'const a={n:1};a.n=({}).missing;', /undefined/],
    ['dynamic constructor read', 'const a=[];const key="constructor";const bad=a[key]===null;', /reflection/],
    ['dynamic prototype read', 'const a={};const key="prototype";const bad=a[key]===null;', /reflection/],
    ['dynamic nonfinite', 'const a={n:1};a.n=Number("invalid");', /finite|JSON/],
    ['native method mutation', 'const a=[];a.map.__hilo_boundary_probe=7;', /function.*value|function.*escape/i],
    ['native method assign escape', 'const a=[];Object.assign(a.map,{__hilo_boundary_probe:7});', /function.*value|function.*escape/i],
    ['native method callback binding escape', 'const bad=(()=>{const {map:f}=[];Object.assign(f,{__hilo_boundary_probe:7});return 1;})();', /function.*value|function.*escape/i],
    ['native method callback assignment escape', 'const bad=(()=>{let f=0;({map:f}=[]);Object.assign(f,{__hilo_boundary_probe:7});return 1;})();', /function.*value|function.*escape/i],
    ['native method default binding escape', 'const {map:f,x=Object.assign(f,{__hilo_boundary_probe:7})}=[];', /function.*value|function.*escape/i],
    ['callback primitive property write', 'const bad=[1].map(n=>{n.x=1;return n.x??null;});', /property|number/],
    ['cycle member write', 'const a={};a.self=a;', /cycle/],
    ['prototype member write', 'const a={};const key="__proto__";a[key]={};', /prototype|plain/],
    ['primitive member write', 'const a=1;a.x=2;', /property|number/],
]) test('common state rejects ' + name, async t => {
    for (const resumed of [false, true]) {
        const raw = source((resumed ? 'await checkpoint_by_human("Before invalid state");' : '') + body + 'await checkpoint_by_human("Must not deliver");return {value:1};');
        const compiled = compileProgram({files: {'probe.ts': raw}, entries: [{file: 'probe.ts', exportName: 'main'}]});
        assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-pattern-reject-'));
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const entryFile = path.join(root, 'probe.main.itt.impl.json');
        fs.writeFileSync(entryFile, JSON.stringify(compiled.artifacts[0].implementation));
        let run = await startRun({
            intent: 'probe.main', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
            populateSnapshot({snapshotDir}) {
                for (const a of compiled.artifacts) {
                    fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.impl.json'), JSON.stringify(a.implementation));
                    fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.json'), JSON.stringify(a.declaration));
                }
            },
            createResources: () => ({executor: async () => ({outputs: {ok: true}})}),
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
        assert.equal(run.status, 'aborted', JSON.stringify(events(run.runDir).slice(-2)));
        const log = events(run.runDir);
        assert.equal(log.some(e => e.event === 'run_complete'), false);
        assert.equal(log.filter(e => e.event === 'suspended_state').length, resumed ? 1 : 0, 'invalid state must not reach the next Human checkpoint');
        assert.match(JSON.stringify(log), diagnostic);
    }
});

test('cleared destructured objects are released during a later Human wait', () => {
    const child = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, '../fixtures/assignment-memory.cjs')], {
        encoding: 'utf8',
        timeout: 60000
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    memoryEvidence = JSON.parse(child.stdout);
    assert.equal(memoryEvidence.clearedSourceReleased, true);
    assert.equal(memoryEvidence.clearedAliasReleased, true);
    assert.equal(memoryEvidence.checkedDuringHumanWait, true);
});

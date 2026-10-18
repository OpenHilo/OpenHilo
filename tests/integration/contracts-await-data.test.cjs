const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const ts = require('typescript');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const records = [];
const cases = [
    ['await array index assignment', 'const rows=[{value:0}];const alias=rows;/*pause*/rows[0]=await child();return {value:[rows===alias,alias[0]]};', 'export async function child():Promise<{value:number}>{/*pause*/return {value:8};}'],

    ['file shaped data', 'const x={type:"file_ref",path:"hello",hash:"h",mtime:1};/*pause*/const y=x;return {value:[y===x,typeof y,y]};'],
    ['nested file shaped alias', 'const x={item:{type:"file_ref",path:"hello",hash:"h",mtime:1}};const y=x.item;/*pause*/return {value:[y===x.item,y.path,typeof y]};'],
    ['file shaped child passthrough', 'const x={type:"file_ref",path:"hello",hash:"h",mtime:1};const out=await child(x);/*pause*/return {value:[out.item===x,typeof out.item,out.item]};', 'export async function child(item:object):Promise<{item:object}>{/*pause*/return {item};}'],
    ['await reassignment', 'let out={value:0};/*pause*/out=await child(2);return out;', 'export async function child(n:number):Promise<{value:number}>{/*pause*/return {value:n};}'],
    ['await destructuring assignment', 'let a=0,b=0;/*pause*/({a,b}=await child());return {value:[a,b]};', 'export async function child():Promise<{a:number,b:number}>{/*pause*/return {a:2,b:3};}'],
    ['await nested property assignment', 'const box={slot:{value:0}};const alias=box;/*pause*/box.slot=await child();return {value:[box===alias,alias.slot]};', 'export async function child():Promise<{value:number}>{/*pause*/return {value:4};}'],
    ['await target evaluated before child', 'const original={slot:{value:0}};const holder={current:original};const seen=[];holder.current[(seen.push("key"),"slot")]=await child(holder,seen);/*pause*/return {value:[original.slot,holder.current.slot,seen]};', 'export async function child(holder:any,seen:unknown[]):Promise<{value:number}>{seen.push("child");holder.current={slot:{value:9}};/*pause*/return {value:4};}'],
    ['wrapped await initializer', 'const out=((await ((child)(3))) as {value:number});/*pause*/return out;', 'export async function child(n:number):Promise<{value:number}>{/*pause*/return {value:n};}'],
    ['wrapped standalone await', 'const box={n:0};(await (child(box)));/*pause*/return {value:box.n};', 'export async function child(box:{n:number}):Promise<{}>{box.n++;/*pause*/return {};}'],
    ['return await preserves container', 'const input={value:[1]};const out=await outer(input);/*pause*/return {value:[out===input,out.value]};', 'export async function child(input:{value:number[]}):Promise<{value:number[]}>{/*pause*/return input;}export async function outer(input:{value:number[]}):Promise<{value:number[]}>{return ((await (child(input))) as {value:number[]});}'],
    ['conditional return', 'const a={value:[1]},b={value:[2]};/*pause*/return true?a:b;'],
    ['property return', 'const holder={result:{value:2}};/*pause*/return holder.result;'],
    ['spread return', 'const source={value:{n:1}};/*pause*/return {...source};'],
    ['computed return field', 'const key="value";const log=[];/*pause*/return {[(log.push("key"),key)]:(log.push("value"),log)};'],
    ['return expression once', 'const values=[{value:1},{value:2}];/*pause*/return values.pop();'],
    ['await loop assignment', 'let result={value:0};for(const n of [1,2]){/*pause*/result=await child(n);}return result;', 'export async function child(n:number):Promise<{value:number}>{/*pause*/return {value:n};}'],
];
const declarations = 'declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;';

function source(body, helper = '', pauses = true) {
    return declarations + '\n' + helper + '\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");' + body + '}';
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const [name, body, helper] of cases) test('contracts await data: ' + name, {timeout: 60000}, async t => {
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
    if (process.env.HILO_CONTRACTS_REPORT) fs.writeFileSync(process.env.HILO_CONTRACTS_REPORT, JSON.stringify({
        node: process.version,
        records
    }, null, 2) + '\n');
});

for (const [name, body, diagnostic] of [
    ['conditional primitive return', 'const flag=true;return flag?1:{value:2};', /return.*object/i],
    ['spread missing field', 'const input={};return {...input};', /return.*field|output.*field/i],
    ['spread extra field', 'const input={value:1,extra:2};return {...input};', /return.*field|output.*field/i],
    ['computed wrong field', 'const key="wrong";return {[key]:1};', /return.*field|output.*field/i],
    ['method returns undefined', 'const items=[];return items.pop();', /return.*object/i],
]) test('await return boundary: ' + name, async t => {
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

test('external Human await assignment and return survive fresh processes', {timeout: 60000}, async t => {
    const raw = `declare function answer_by_human(prompt:string):Promise<{value:number}>;
 export async function child():Promise<{value:number}>{return ((await (answer_by_human)("Continue")));}
 export async function main():Promise<{value:unknown}>{const box={out:{value:0}};box.out=await answer_by_human("Answer");let out={value:0};out=await child();return {value:[box.out.value,out.value]};}`;
    const context = {exports: {}, answer_by_human: async () => ({value: 7})};
    vm.runInNewContext(ts.transpile(raw, {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}), context);
    const expected = JSON.parse(JSON.stringify(await context.exports.main()));
    const c = compileProgram({files: {'probe.ts': raw}, entries: [{file: 'probe.ts', exportName: 'main'}]});
    assert.equal(c.ok, true, JSON.stringify(c.diagnostics));
    for (const mode of ['inline-human', 'new-process']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-await-human-'));
        t.after(() => fs.rmSync(root, {recursive: true, force: true}));
        const entryFile = path.join(root, 'probe.main.itt.impl.json');
        fs.writeFileSync(entryFile, JSON.stringify(c.artifacts.find(a => a.id === 'probe.main').implementation));
        let presentations = 0;
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
                    throw new Error('Unexpected external effect');
                }
            }),
            ...(mode === 'inline-human' ? {
                humanExecutor: {
                    id: 'inline', async present(task, ctx) {
                        presentations++;
                        assert.equal((await ctx.submit({
                            taskId: task.taskId,
                            submissionId: 'answer-' + presentations,
                            outputs: {value: '7'}
                        })).status, 'accepted');
                    }
                }
            } : {}),
        });
        let resumes = 0;
        while (run.status === 'suspended') {
            assert.equal(mode, 'new-process');
            assert.ok(++resumes <= 2);
            const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/await-human-resume.cjs'), run.runDir], {
                encoding: 'utf8',
                timeout: 30000
            });
            assert.equal(child.status, 0, child.stderr);
            run = JSON.parse(child.stdout);
        }
        assert.equal(run.status, 'completed', JSON.stringify(events(run.runDir).slice(-3)));
        assert.deepEqual(events(run.runDir).find(e => e.event === 'run_complete').outputs, expected);
        assert.equal(mode === 'new-process' ? resumes : presentations, 2);
    }
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {compileProgram, compileMultiIntent} = require('@openhilo/compiler');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {
    ScopeManager,
    EvalEngine,
    decodeCheckpointStack,
    encodeStateGraph,
    decodeStateGraph
} = require('@openhilo/runtime');
const declarations = `declare function ask_by_human(prompt: string): Promise<{ ok: boolean }>;
declare function data_by_ai(role: string, prompt: string): Promise<{ a: object; b: object }>;`;
const compile = body => compileProgram({
    files: {'main.ts': declarations + '\n' + body},
    entries: [{file: 'main.ts', exportName: 'main'}]
});

function setup(t, source) {
    const compiled = compile(source);
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-semantics-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'main.main.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify(compiled.artifacts.find(a => a.id === 'main.main').implementation));
    return {
        intent: 'main.main', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot({snapshotDir}) {
            for (const a of compiled.artifacts) {
                fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.impl.json'), JSON.stringify(a.implementation));
                fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.json'), JSON.stringify(a.declaration));
            }
        },
        createResources: () => ({
            executor: async () => {
                throw Error('Unexpected executor');
            }
        })
    };
}

const events = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map(e => e.call_stack ? {
    ...e,
    call_stack: decodeCheckpointStack(e.call_stack)
} : e);
const output = dir => events(dir).find(e => e.event === 'run_complete')?.outputs;

for (const [name, body, expected] of [
    ['block shadowing', 'let x=1; {const x=2;} if(true){const x=3;} return {value:x};', 1],
    ['loop shadowing', 'let x=9; for(let x=0;x<2;x++){} return {value:x};', 9],
    ['nested loops and jumps', 'let total=0; for(let i=0;i<3;i++){for(let i=0;i<3;i++){if(i===1)continue;if(i===2)break;total+=1;}total+=i;}return {value:total};', 6],
    ['sibling scopes and shorthand', 'let x=10; let total=0; {const x=2;const o={x}; total+=o.x;} {const x=3;total+=x;} return {value:total+x};', 15],
    ['foreach and enclosing updates', 'let item=10;let sum=0;for(const item of [1,2,3]){sum+=item;}return {value:sum+item};', 16],
]) {
    test(name, async t => {
        const r = await startRun(setup(t, `export async function main():Promise<{value:number}>{${body}}`));
        assert.equal(r.status, 'completed');
        assert.deepEqual(output(r.runDir), {value: expected});
    });
}

test('renaming preserves property keys, template interpolation, callbacks and awaited bindings', async t => {
    const r = await startRun({
        ...setup(t, `export async function main():Promise<{value:string}>{let x='outer';let result='';{const {ok:x}=await ask_by_human('Continue?');const values=[1,2].map(x=>x+1);const obj={x};result=\`\${obj.x}:\${values.join(',')}:\${[1].map(n=>String(x)+n).join('')}\`;}return {value:x+':'+result};}`),
        humanExecutor: {
            id: 'inline', async present(task, ctx) {
                await ctx.submit({taskId: task.taskId, submissionId: 'yes', outputs: {ok: 'true'}});
            }
        }
    });
    assert.equal(r.status, 'completed');
    assert.deepEqual(output(r.runDir), {value: 'outer:true:2,3:true1'});
});

for (const body of [
    'const x=1;x=2;return {value:x};',
    'let x=1;{x;const x=2;}return {value:x};',
    'if(true){const x=2;}return {value:x};',
    'let x=1;let x=2;return {value:x};',
    'for(let i=0;i<2;i++){}return {value:i};',
]) test('invalid lexical use is rejected: ' + body, () => {
    const source = `export async function main():Promise<{value:number}>{${body}}`;
    const result = compile(source);
    assert.equal(result.ok, false);
    assert.equal(result.artifacts.length, 0);
    assert.throws(() => compileMultiIntent(source), /scope|declar|constant|initializ|before|Cannot/i);
});

test('nested workflow loop resumes with shadowed locals and releases exited block data', async t => {
    const source = `export async function child():Promise<{value:number}>{let x=10;let sum=0;for(let x=0;x<2;x++){ {const data=[1,2,3];sum+=data.length;} const {ok}=await ask_by_human('Continue?');if(ok)sum+=x;}return {value:sum+x};}
 export async function main():Promise<{value:number}>{const {value}=await child();return {value};}`;
    const f = setup(t, source);
    let run = await startRun(f);
    let rounds = 0;
    while (run.status === 'suspended') {
        const state = events(run.runDir).filter(e => e.event === 'suspended_state').at(-1);
        for (const frame of state.call_stack) for (const scope of frame.scope_stack) assert.ok(!Object.values(scope.vars).some(v => Array.isArray(v) && v.join(',') === '1,2,3'), 'exited block must release array');
        run = await resumeRun({runDir: run.runDir, humanOutput: {ok: 'true'}, createResources: f.createResources});
        assert.ok(++rounds <= 2);
    }
    assert.equal(run.status, 'completed');
    assert.equal(rounds, 2);
    assert.deepEqual(output(run.runDir), {value: 17});
});

test('executor output payload aliases have identical reference semantics with and without human restart', async t => {
    const source = `export async function main():Promise<{value:number}>{const {a,b}=await data_by_ai('worker','data');const {ok}=await ask_by_human('Continue?');const n=Object.assign(a,{n:2}).n;return {value:b.n};}`;
    for (const restart of [false, true]) {
        const f = setup(t, source);
        const createResources = () => ({
            executor: async () => {
                const shared = {n: 1};
                return {outputs: {a: shared, b: shared}};
            }
        });
        let run = await startRun({
            ...f, createResources, ...(!restart ? {
                humanExecutor: {
                    id: 'inline',
                    async present(task, ctx) {
                        await ctx.submit({taskId: task.taskId, submissionId: 'yes', outputs: {ok: 'true'}});
                    }
                }
            } : {})
        });
        if (restart) {
            assert.equal(run.status, 'suspended');
            run = await resumeRun({runDir: run.runDir, humanOutput: {ok: 'true'}, createResources});
        }
        assert.equal(run.status, 'completed');
        assert.deepEqual(output(run.runDir), {value: 2}, 'aliases must not change at persistence boundary');
    }
});

test('host/executor inputs do not share mutable ownership with workflow state', async t => {
    const source = `declare function edit_by_ai(role:string,prompt:string,data:object):Promise<{ok:boolean}>;
 export async function main(data:object):Promise<{value:number}>{const {ok}=await edit_by_ai('worker','edit',data);return {value:data.n};}`;
    const input = {n: 1};
    const r = await startRun({
        ...setup(t, source),
        inputs: {data: JSON.stringify(input)},
        inputEncoding: 'typed-text-v1',
        createResources: () => ({
            executor: async (_node, inputs) => {
                inputs.data.n = 2;
                return {outputs: {ok: true}};
            }
        })
    });
    assert.equal(r.status, 'completed');
    assert.deepEqual(output(r.runDir), {value: 1});
    assert.deepEqual(input, {n: 1});
});

test('scope snapshots detach ownership but preserve shared roots', () => {
    const original = {n: 1};
    const s = new ScopeManager();
    s.push({kind: 'base', vars: {}});
    s.write('a', {left: original, right: original});
    s.write('b', original);
    const r = new ScopeManager();
    r.deserialize(decodeStateGraph(JSON.parse(JSON.stringify(encodeStateGraph(s.serialize())))));
    assert.notEqual(r.read('b'), original);
    for (const scope of [s, r]) {
        scope.read('a').left.n = 2;
        assert.equal(scope.read('a').right.n, 2);
        assert.equal(scope.read('b').n, 2);
    }
});

test('expression-created aliases do not change behavior after a checkpoint', async t => {
    const source = `export async function main():Promise<{value:number}>{const data={n:1};const items=[];items.push(data);const {ok}=await ask_by_human('Continue?');Object.assign(data,{n:2});return {value:items[0].n};}`;
    for (const restart of [false, true]) {
        const f = setup(t, source);
        let run = await startRun({
            ...f, ...(!restart ? {
                humanExecutor: {
                    id: 'inline', async present(task, ctx) {
                        await ctx.submit({taskId: task.taskId, submissionId: 'yes', outputs: {ok: 'true'}});
                    }
                }
            } : {})
        });
        if (restart) run = await resumeRun({
            runDir: run.runDir,
            humanOutput: {ok: 'true'},
            createResources: f.createResources
        });
        assert.equal(run.status, 'completed');
        assert.deepEqual(output(run.runDir), {value: 2});
    }
});

test('a new Node process restores shadowed scopes and value ownership without replay', async t => {
    const {spawnSync} = require('node:child_process');
    const source = `export async function main():Promise<{value:number}>{let x=10;let value=0;{const {a,b}=await data_by_ai('worker','data');const x=2;const {ok}=await ask_by_human('Continue?');Object.assign(a,{n:4});value=b.n+x;}return {value:value+x};}`;
    let calls = 0;
    const run = await startRun({
        ...setup(t, source), createResources: () => ({
            executor: async () => {
                calls++;
                const shared = {n: 1};
                return {outputs: {a: shared, b: shared}};
            }
        })
    });
    assert.equal(run.status, 'suspended');
    assert.equal(calls, 1);
    const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/semantics-resume.cjs'), run.runDir], {
        encoding: 'utf8',
        timeout: 30000
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {status: 'completed', outputs: {value: 16}});
});

// Measure application reachability in a fixed interpreter mode. Optimized-code
// temporary roots and compilation caches vary across V8/CPU builds and are not
// workflow ownership. Both the release probe and retained-scope negative control
// use this mode; ordinary semantics and recovery tests still run with the JIT.
test('run scopes and resource handles are released across repeated completion, suspension and failure', () => {
    const {spawnSync} = require('node:child_process');
    const child = spawnSync(process.execPath, ['--jitless', '--expose-gc', path.join(__dirname, '../fixtures/semantics-memory.cjs')], {
        encoding: 'utf8',
        timeout: 60000
    });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.runs, 84);
    assert.equal(report.closed, 84);
    assert.equal(report.liveScopes, 0);
    assert.equal(report.loopTargetRetainedWhileActive, true);
    assert.equal(report.loopTargetReleasedAfterExit, true);
    console.log('Memory lifecycle evidence: ' + JSON.stringify(report));
});

test('memory lifecycle probe detects a strongly retained exited loop', () => {
    const {spawnSync} = require('node:child_process');
    const child = spawnSync(process.execPath, ['--jitless', '--expose-gc', path.join(__dirname, '../fixtures/semantics-memory.cjs'), '--retain-exited-loop'], {
        encoding: 'utf8',
        timeout: 60000
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.match(child.stderr, /exited iterator must not pin its cleared target during the next human wait/);
});

test('unbraced loop bodies do not clear loop bindings before the increment', async t => {
    const r = await startRun(setup(t, `export async function main():Promise<{value:number}>{let total=0;for(let i=0;i<2&&total<5;i++)total+=1;return {value:total};}`));
    assert.equal(r.status, 'completed');
    assert.deepEqual(output(r.runDir), {value: 2});
});

test('discarded expressions neither retain block objects nor overwrite user variables', async t => {
    const f = setup(t, `export async function main():Promise<{value:number}>{const __itt_expr_1=99;{const data=[1,2,3];Object.assign(data,{});}1+2;const {ok}=await ask_by_human('Wait');return {value:__itt_expr_1};}`);
    const run = await startRun(f);
    assert.equal(run.status, 'suspended');
    const state = events(run.runDir).filter(e => e.event === 'suspended_state').at(-1);
    for (const frame of state.call_stack) for (const scope of frame.scope_stack) assert.ok(!Object.values(scope.vars).some(Array.isArray), 'expression temporaries must not retain discarded arrays');
    const done = await resumeRun({runDir: run.runDir, humanOutput: {ok: 'true'}, createResources: f.createResources});
    assert.equal(done.status, 'completed');
    assert.deepEqual(output(done.runDir), {value: 99});
});

for (const body of [
    `{const hidden=1;}await relay(hidden);return {value:1};`,
    `{const hidden=1;}hidden=2;return {value:1};`,
    `let sum=0;const values=[1,2].map(n=>sum+=n);return {value:sum};`,
    `let x=1;const y=x++;return {value:x};`,
    `{const relay=1;await relay(1);}return {value:1};`,
]) test('unsupported lexical effects fail before execution: ' + body, () => {
    const result = compile(`export async function relay(n:number):Promise<{value:number}>{return {value:n};}export async function main():Promise<{value:number}>{${body}}`);
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
});

test('a block shadowing a built-in does not hide that built-in after exit', async t => {
    const run = await startRun(setup(t, `export async function main():Promise<{value:number}>{let value=0;{const Math={max:3};value+=Math.max;}return {value:value+Math.max(2,4)};}`));
    assert.equal(run.status, 'completed');
    assert.deepEqual(output(run.runDir), {value: 7});
});

for (const expr of ['(([x]=[2]),0)', '(((x)=2),0)', '(({x}={x:2}),0)']) test('embedded assignment patterns cannot silently lose updates: ' + expr, () => {
    const result = compile(`export async function main():Promise<{value:number}>{let x=1;const y=${expr};return {value:x};}`);
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
});

test('long loops clear large block temporaries on continue before human suspension', async t => {
    const f = setup(t, `export async function main():Promise<{value:number}>{let total=0;for(let i=0;i<120;i++){{const scratch=Array.from({length:2000},(_,j)=>j);total+=scratch.length;if(i%2===0)continue;}}const {ok}=await ask_by_human('Done?');return {value:total};}`);
    const run = await startRun(f);
    assert.equal(run.status, 'suspended');
    const state = events(run.runDir).filter(e => e.event === 'suspended_state').at(-1);
    assert.ok(JSON.stringify(state.call_stack).length < 3000, 'checkpoint should contain live values, not prior loop arrays');
    for (const frame of state.call_stack) for (const scope of frame.scope_stack) assert.ok(!Object.values(scope.vars).some(Array.isArray));
    const done = await resumeRun({runDir: run.runDir, humanOutput: {ok: 'true'}, createResources: f.createResources});
    assert.equal(done.status, 'completed');
    assert.deepEqual(output(done.runDir), {value: 240000});
});

for (const loop of ['for(x of [2]){}', 'for(x in {a:1}){}']) test('callback loop assignment cannot mutate an outer workflow binding: ' + loop, () => {
    const result = compile(`export async function main():Promise<{value:number}>{let x=1;const y=[0].map(()=>{${loop}return 0;});return {value:x};}`);
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
});

test('legacy source-root bindings may shadow expression builtins', () => {
    const {validateTranslatorTs} = require('@openhilo/compiler');
    const {astToITT} = require('@openhilo/compiler/ast-to-itt');
    const validation = validateTranslatorTs('const Math=1;');
    assert.equal(validation.ok, true);
    const cfg = astToITT(validation.sourceFile, validation.declarations);
    assert.equal(cfg.nodes[cfg.entry].assignments[0].var, 'Math');
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {compileProgram} = require('@openhilo/compiler');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {decodeCheckpointStack} = require('@openhilo/runtime');
const read = dir => fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function setup(t, body, declarations = '') {
    const source = 'declare function wait_by_human(prompt:string):Promise<{ok:boolean}>;' + declarations + '\nexport async function main():Promise<{value:unknown}>{' + body + '}';
    const compiled = compileProgram({files: {'probe.ts': source}, entries: [{file: 'probe.ts', exportName: 'main'}]});
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-reference-boundaries-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'probe.main.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify(compiled.artifacts[0].implementation));
    return {
        intent: 'probe.main', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
        populateSnapshot({snapshotDir}) {
            for (const a of compiled.artifacts) {
                fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.impl.json'), JSON.stringify(a.implementation));
                fs.writeFileSync(path.join(snapshotDir, a.id + '.itt.json'), JSON.stringify(a.declaration));
            }
        },
        createResources: () => ({
            executor: async () => {
                throw Error('Unexpected external effect');
            }
        })
    };
}

const inline = {
    id: 'inline', async present(task, ctx) {
        assert.equal((await ctx.submit({taskId: task.taskId, submissionId: 'answer', outputs: {}})).status, 'accepted');
    }
};
test('executor payloads and observers preserve aliases inside their own detached ownership', async t => {
    const f = setup(t, 'const a={n:1};await inspect_by_ai("worker","inspect",a,a);const {left,right}=await make_by_ai("worker","make");await wait_by_human("Continue");Object.assign(left,{n:3});return {value:[a.n,left===right,right.n]};',
        'declare function inspect_by_ai(role:string,prompt:string,a:object,b:object):Promise<{ok:boolean}>;declare function make_by_ai(role:string,prompt:string):Promise<{left:object;right:object}>;');
    let heldInput, heldOutput;
    const observations = [];
    const run = await startRun({
        ...f, createResources: () => ({
            executor: async (_node, inputs) => {
                if (inputs.a) {
                    assert.equal(inputs.a, inputs.b);
                    heldInput = inputs;
                    inputs.a.n = 50;
                    return {outputs: {ok: true}};
                }
                heldOutput = {n: 1};
                return {outputs: {left: heldOutput, right: heldOutput}};
            }
        }), onEvent(event) {
            if (event.event === 'node_success' && event.outputs.left) {
                assert.equal(event.outputs.left, event.outputs.right);
                observations.push(event);
                event.outputs.left.n = 80;
            }
        }, humanExecutor: {
            id: 'boundary-probe', async present(task, ctx) {
                heldInput.a.n = 90;
                heldOutput.n = 99;
                await inline.present(task, ctx);
            }
        }
    });
    assert.equal(run.status, 'completed');
    assert.deepEqual(read(run.runDir).find(e => e.event === 'run_complete').outputs, {value: [1, true, 3]});
    assert.equal(heldOutput.n, 99);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].outputs.left.n, 80, 'later workflow writes must not alter an earlier observer snapshot');
});
for (const expression of ['Object.freeze(a)', 'Object.seal(a)', 'Object.preventExtensions(a)', 'Object.defineProperty(a,"n",{writable:false})', 'Object.setPrototypeOf(a,null)', 'Object.setPrototypeOf(a,Object.create(null,Object.getOwnPropertyDescriptors(Object.prototype)))', 'Object.assign(a,{self:a})'])
    test('in-place unsupported state rejects before checkpoint: ' + expression, async t => {
        if (expression !== 'Object.assign(a,{self:a})') {
            const compiled = compileProgram({
                files: {'probe.ts': 'export async function main():Promise<{value:number}>{const a={n:1};' + expression + ';return {value:1};}'},
                entries: [{file: 'probe.ts', exportName: 'main'}]
            });
            assert.equal(compiled.ok, false);
            assert.deepEqual(compiled.artifacts, []);
            assert.ok(compiled.diagnostics.some(d => d.line > 0 && d.column > 0));
            return;
        }
        const f = setup(t, 'const a={n:1};' + expression + ';await wait_by_human("Must not deliver");return {value:1};');
        let delivered = 0;
        const run = await startRun({
            ...f, humanExecutor: {
                id: 'unexpected', async present() {
                    delivered++;
                }
            }
        });
        assert.equal(run.status, 'aborted');
        assert.equal(delivered, 0);
        assert.equal(read(run.runDir).some(e => ['suspended_state', 'run_complete'].includes(e.event)), false);
        assert.match(JSON.stringify(read(run.runDir)), /JSON-compatible/);
    });
test('saved clock and random observations survive a fresh process without recomputation', async t => {
    const run = await startRun(setup(t, 'const t=Date.now();const r=Math.random();const saved={t,r};await wait_by_human("Continue");return {value:[saved.t,saved.r,t===saved.t,r===saved.r,Date.now(),Math.random()]};'));
    assert.equal(run.status, 'suspended');
    const frames = decodeCheckpointStack(read(run.runDir).at(-1).call_stack);
    const stored = frames.flatMap(f => f.scope_stack.flatMap(s => Object.values(s.vars))).find(v => v && typeof v === 'object' && typeof v.t === 'number' && typeof v.r === 'number');
    assert.ok(stored);
    const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/upstream-resume.cjs'), run.runDir], {
        encoding: 'utf8',
        timeout: 30000
    });
    assert.equal(child.status, 0, child.stderr);
    const values = read(run.runDir).find(e => e.event === 'run_complete').outputs.value;
    assert.deepEqual(values.slice(0, 4), [stored.t, stored.r, true, true]);
    assert.ok(Number.isFinite(values[4]));
    assert.ok(values[5] >= 0 && values[5] < 1);
    // No exact elapsed/random-sequence claim: clock corrections and new draws are allowed.
});
for (const corruption of ['unknown-version', 'dangling-reference', 'duplicate-key', 'cycle']) test('resume rejects ' + corruption + ' before resource creation or changing records', async t => {
    const f = setup(t, 'const a={n:1};await wait_by_human("Continue");return {value:a.n};');
    const run = await startRun(f);
    assert.equal(run.status, 'suspended');
    const events = read(run.runDir);
    const graph = events.at(-1).call_stack;
    assert.equal(Array.isArray(graph), false);
    if (corruption === 'unknown-version') graph.version = 99;
    if (corruption === 'dangling-reference') graph.root = {ref: graph.nodes.length};
    const object = graph.nodes.find(n => n.kind === 'object');
    if (corruption === 'duplicate-key') object.entries.push(object.entries[0]);
    if (corruption === 'cycle') object.entries.push(['cycle', graph.root]);
    const file = path.join(run.runDir, 'execution.jsonl');
    fs.writeFileSync(file, events.map(JSON.stringify).join('\n') + '\n');
    const before = fs.readFileSync(file, 'utf8'), record = fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8');
    let calls = 0;
    await assert.rejects(resumeRun({
        runDir: run.runDir, humanOutput: {}, createResources() {
            calls++;
            throw Error('Must not open');
        }
    }), /graph|cycle/i);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(run.runDir, 'run.json'), 'utf8'), record);
});
test('actual legacy tree suspension remains resumable', async t => {
    const f = setup(t, 'const a={n:7};await wait_by_human("Continue");return {value:a.n};');
    const run = await startRun(f);
    const events = read(run.runDir);
    events.at(-1).call_stack = decodeCheckpointStack(events.at(-1).call_stack);
    fs.writeFileSync(path.join(run.runDir, 'execution.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
    const done = await resumeRun({runDir: run.runDir, humanOutput: {}, createResources: f.createResources});
    assert.equal(done.status, 'completed');
    assert.deepEqual(read(run.runDir).find(e => e.event === 'run_complete').outputs, {value: 7});
});

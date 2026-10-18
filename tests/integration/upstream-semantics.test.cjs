// Adapted upstream semantic tests, not a Test262 conformance runner.
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const corpusDir = path.join(__dirname, '../upstream');
const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'));
const results = [];
let originals = [];
test('selected upstream originals pass their native reference assertions', () => {
    originals = require('../fixtures/upstream-originals.cjs').verifyOriginals(corpusDir, manifest);
});
const declarations = `declare function checkpoint_by_human(prompt:string):Promise<{ok:boolean}>;
declare function once_by_code(lang:string,script:string):Promise<{ok:boolean}>;`;

function sourceFor(body, pauses = true) {
    return declarations + '\nexport async function subject():Promise<{value:unknown}>{' +
        body.replaceAll('/*checkpoint*/', pauses ? 'await checkpoint_by_human("Resume semantic probe");' : '') +
        '}\nexport async function main():Promise<{value:unknown}>{await once_by_code("javascript","marker");const result=await subject();return {value:result.value};}';
}

function compile(source) {
    return compileProgram({files: {'probe.ts': source}, entries: [{file: 'probe.ts', exportName: 'main'}]});
}

function events(dir) {
    return fs.readFileSync(path.join(dir, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function observed(dir) {
    return events(dir).find(event => event.event === 'run_complete')?.outputs;
}

function options(t, compiled) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-upstream-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const entryFile = path.join(root, 'probe.main.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify(compiled.artifacts.find(a => a.id === 'probe.main').implementation));
    let calls = 0;
    return {
        callCount: () => calls,
        args: {
            intent: 'probe.main', entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
            populateSnapshot({snapshotDir}) {
                for (const artifact of compiled.artifacts) {
                    fs.writeFileSync(path.join(snapshotDir, artifact.id + '.itt.impl.json'), JSON.stringify(artifact.implementation));
                    fs.writeFileSync(path.join(snapshotDir, artifact.id + '.itt.json'), JSON.stringify(artifact.declaration));
                }
            },
            createResources: () => ({
                executor: async () => {
                    assert.equal(++calls, 1, 'pre-child side effect must run exactly once');
                    return {outputs: {ok: true}};
                }
            }),
        },
    };
}

for (const item of manifest.cases) {
    test(`upstream ${item.kind}: ${item.id}`, {timeout: 60000}, async t => {
        const evidence = {
            id: item.id,
            source: item.source,
            path: item.path,
            kind: item.kind,
            status: 'failed',
            resumedProcesses: 0
        };
        results.push(evidence);
        // Pin bytes as well as upstream revision, so provenance cannot drift unnoticed.
        const original = fs.readFileSync(path.join(corpusDir, item.source, item.path));
        assert.equal(crypto.createHash('sha256').update(original).digest('hex'), item.sha256);
        const compiled = compile(sourceFor(item.body));
        if (item.kind === 'reject') {
            assert.equal(compiled.ok, false, 'unsupported/invalid semantics must not produce successful artifacts');
            assert.deepEqual(compiled.artifacts, []);
            assert.match(JSON.stringify(compiled.diagnostics), new RegExp(item.diagnostic, 'i'));
            evidence.diagnostic = compiled.diagnostics;
            evidence.status = 'verified-rejection';
            return;
        }
        assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
        if (item.kind === 'runtime-reject') {
            const f = options(t, compiled);
            const run = await startRun(f.args);
            assert.ok(['aborted', 'failed'].includes(run.status), JSON.stringify(run));
            assert.equal(observed(run.runDir), undefined, 'invalid values must never complete successfully');
            assert.match(JSON.stringify(events(run.runDir)), new RegExp(item.diagnostic, 'i'));
            evidence.status = 'verified-runtime-rejection';
            return;
        }
        // Native reference uses the same adapted statements, without any OpenHilo compiler/runtime.
        const native = await vm.runInNewContext('(async()=>{' + item.body.replaceAll('/*checkpoint*/', '') + '})()', {}, {timeout: 1000});
        assert.deepEqual(JSON.parse(JSON.stringify(native)), {value: item.nativeExpected ?? item.expected}, 'independent native reference and hand-checked upstream expectation');
        evidence.native = JSON.parse(JSON.stringify(native));
        for (const mode of ['continuous', 'inline-human', 'new-process']) {
            const program = mode === 'continuous' ? compile(sourceFor(item.body, false)) : compiled;
            assert.equal(program.ok, true, JSON.stringify(program.diagnostics));
            const f = options(t, program);
            let presentations = 0;
            const humanExecutor = {
                id: 'test-inline', async present(task, ctx) {
                    presentations++;
                    const reply = await ctx.submit({
                        taskId: task.taskId,
                        submissionId: 'answer-' + presentations,
                        outputs: {}
                    });
                    assert.equal(reply.status, 'accepted', JSON.stringify(reply));
                }
            };
            let run = await startRun({...f.args, ...(mode === 'inline-human' ? {humanExecutor} : {})});
            let rounds = 0;
            while (mode === 'new-process' && run.status === 'suspended') {
                assert.ok(++rounds <= 20, 'bounded checkpoint loop; no blind retries');
                const suspended = events(run.runDir).filter(e => e.event === 'suspended_state').at(-1);
                assert.ok(require('@openhilo/runtime').decodeCheckpointStack(suspended.call_stack).length >= 2, 'checkpoint must include the nested subject workflow');
                const child = spawnSync(process.execPath, [path.join(__dirname, '../fixtures/upstream-resume.cjs'), run.runDir], {
                    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
                });
                assert.equal(child.status, 0, child.stderr || child.error?.message);
                run = JSON.parse(child.stdout);
            }
            assert.equal(run.status, 'completed', mode + ': ' + JSON.stringify(events(run.runDir).slice(-3)));
            assert.deepEqual(observed(run.runDir), {value: item.expected}, mode);
            assert.equal(f.callCount(), 1);
            if (mode === 'inline-human') assert.ok(presentations > 0, 'fixture must actually exercise human interaction');
            if (mode === 'new-process') {
                assert.ok(rounds > 0, 'fixture must actually suspend');
                evidence.resumedProcesses = rounds;
            }
        }
        evidence.status = item.kind === 'difference' ? 'verified-difference' : 'passed-adaptation';
    });
}
after(() => {
    if (process.env.HILO_UPSTREAM_REPORT) {
        fs.writeFileSync(process.env.HILO_UPSTREAM_REPORT, JSON.stringify({
            node: process.version, platform: process.platform,
            arch: process.arch, sources: manifest.sources, originals, results
        }, null, 2) + '\n');
    }
});

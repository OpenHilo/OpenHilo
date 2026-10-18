const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EvalEngine} = require('../dist');
test('workflow return guard checks exact own fields without changing object identity', async () => {
    const engine = new EvalEngine();
    const value = {value: {n: 1}};
    assert.equal(await engine.eval('__openhilo_return_value__(value,["value"])', {value}), value);
    assert.deepEqual(await engine.eval('__openhilo_return_value__(value,[])', {value: {}}), {});
    for (const value of [null, [], 1, "x", {}, {value: 1, extra: 2}])
        await assert.rejects(engine.eval('__openhilo_return_value__(value,["value"])', {value}), /return.*object|return.*field/i);
});
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {startRun} = require('../dist/run-service');
for (const nested of [false, true]) for (const value of [null, {
    value: 7,
    extra: 1
}]) test('raw result metadata validates actual object ' + JSON.stringify({nested, value}), async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-result-metadata-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const child = {
        version: 2,
        entry: 'set',
        resultVar: 'result',
        outputs: {value: 'value'},
        nodes: {
            set: {
                id: 'set',
                type: 'assign',
                assignments: [{var: 'value', type: 'number', expr: '7'}, {
                    var: 'result',
                    type: 'json',
                    expr: JSON.stringify(value)
                }],
                next: 'END'
            }
        }
    };
    const parent = {
        version: 2,
        entry: 'call',
        outputs: {value: 'result'},
        nodes: {
            call: {
                id: 'call',
                type: 'call',
                executor: 'intent',
                callee: 'child',
                inputsFrom: {},
                outputsTo: {},
                resultTo: 'result',
                next: 'END'
            }
        }
    };
    const entryFile = path.join(root, 'main.itt.impl.json');
    fs.writeFileSync(entryFile, JSON.stringify(nested ? parent : child));
    const run = await startRun({
        intent: 'main',
        entryFile,
        workdir: root,
        runsDir: path.join(root, 'runs'),
        inputs: {},
        createResources: () => ({
            executor: async () => {
                throw new Error('unexpected external call');
            }
        }),
        populateSnapshot({snapshotDir}) {
            fs.writeFileSync(path.join(snapshotDir, 'main.itt.impl.json'), JSON.stringify(nested ? parent : child));
            fs.writeFileSync(path.join(snapshotDir, 'child.itt.impl.json'), JSON.stringify(child));
        }
    });
    assert.equal(run.status, 'aborted');
    const log = fs.readFileSync(path.join(run.runDir, 'execution.jsonl'), 'utf8');
    assert.match(log, /return.*object|return.*field/i);
    const events = log.trim().split('\n').map(JSON.parse);
    assert.equal(events.some(e => e.event === 'run_complete'), false);
    if (nested) {
        const calls = events.filter(e => e.event === 'node_pending' && e.node_id === 'call').map(e => e.node_run_id);
        assert.equal(calls.length, 1);
        assert.equal(events.some(e => e.event === 'node_success' && calls.includes(e.node_run_id)), false);
    }
});

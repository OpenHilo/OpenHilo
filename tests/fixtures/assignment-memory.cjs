// Observe actual workflow objects at an active Human wait, without retaining them.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {compileProgram} = require('@openhilo/compiler');
const {startRun} = require('@openhilo/runtime/run-service');
const {EvalEngine} = require('@openhilo/runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-pattern-memory-'));
const originalEval = EvalEngine.prototype.eval;
const references = [];
EvalEngine.prototype.eval = async function (...args) {
    const value = await originalEval.apply(this, args);
    if (value && value.item && value.item.marker === 'pattern-owner' && references.length === 0) {
        references.push(new WeakRef(value), new WeakRef(value.item));
    }
    return value;
};
(async () => {
    try {
        const source = `declare function wait_by_human(prompt:string):Promise<{ok:boolean}>;
export async function main():Promise<{value:number}>{
 let source={item:{marker:'pattern-owner',payload:Array.from({length:20000},(_,i)=>i)},other:1};
 let {item:alias,...rest}=source;let [again]=[alias];
 source=null;alias=null;again=null;rest=null;
 await wait_by_human("After bindings cleared");return {value:1};
}`;
        const compiled = compileProgram({
            files: {'probe.ts': source},
            entries: [{file: 'probe.ts', exportName: 'main'}]
        });
        assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
        const artifact = compiled.artifacts[0];
        const entryFile = path.join(root, artifact.id + '.itt.impl.json');
        fs.writeFileSync(entryFile, JSON.stringify(artifact.implementation));
        let checked = false;
        const run = await startRun({
            intent: artifact.id, entryFile, workdir: root, runsDir: path.join(root, 'runs'), inputs: {},
            populateSnapshot({snapshotDir}) {
                fs.copyFileSync(entryFile, path.join(snapshotDir, path.basename(entryFile)));
            },
            createResources: () => ({
                executor: async () => {
                    throw Error('No external effects expected');
                }
            }),
            humanExecutor: {
                id: 'pattern-memory', async present() {
                    for (let i = 0; i < 4; i++) {
                        await new Promise(resolve => setImmediate(resolve));
                        global.gc();
                    }
                    assert.equal(references.length, 2);
                    assert.ok(references.every(reference => reference.deref() === undefined), 'pattern temporaries must not retain cleared workflow objects during a later Human wait');
                    checked = true;
                }
            },
        });
        assert.equal(run.status, 'suspended');
        assert.equal(checked, true);
        console.log(JSON.stringify({
            clearedSourceReleased: true,
            clearedAliasReleased: true,
            checkedDuringHumanWait: true
        }));
    } finally {
        EvalEngine.prototype.eval = originalEval;
        fs.rmSync(root, {recursive: true, force: true});
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

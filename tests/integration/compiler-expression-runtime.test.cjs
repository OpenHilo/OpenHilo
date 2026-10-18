const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {compileProgram, compileMultiIntent} = require('@openhilo/compiler');
const {ExecutionEngine, EvalEngine} = require('@openhilo/runtime');
const {IttValidator: Validator} = require('@openhilo/itt-contracts');
const {createCodeExecutor} = require('@openhilo/code-local');

const source = `
export async function identity(value: number): Promise<{ value: number }> { return { value }; }
export async function main(): Promise<{ value: number; mapped: string[]; literal: string }> {
  const values: number[] = [1, 2].map(<T extends number>(n: T): number => n + 1);
  let total: number = (0 as number);
  for (let i: number = (0 as number); (i as number) < values.length; i += (1 as number)) {
    total += (values[i]! as number);
  }
  if ((total as number) === 5) total = (<number>total) + 1;
  for (const value of (values as number[])) { total += value as number; }
  const { value: returned } = await identity((total as number));
  return {
    value: ({ n: returned } satisfies { n: number })!.n,
    mapped: values.filter((n?: number): boolean => n! > 0).map((n: number): string => \`v\${n as number}\`),
    literal: '(as number)! satisfies { n: number }'
  };
}`;

for (const mode of ['virtual', 'legacy']) test(`${mode} compilation erases nested types across CFG positions and preserves runtime values`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-expressions-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    let artifacts, entry;
    if (mode === 'virtual') {
        const result = compileProgram({files: {'main.ts': source}, entries: [{file: 'main.ts', exportName: 'main'}]});
        assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
        artifacts = result.artifacts;
        entry = result.entries[0];
    } else {
        artifacts = compileMultiIntent(source).intents.map(intent => ({...intent, id: intent.name}));
        entry = 'main';
    }
    const snapshot = path.join(directory, '.snapshot');
    fs.mkdirSync(snapshot);
    fs.mkdirSync(path.join(directory, 'io_records'));
    for (const artifact of artifacts) {
        assert.deepEqual(new Validator().validate(artifact.implementation).errors, []);
        fs.writeFileSync(path.join(snapshot, `${artifact.id}.itt.impl.json`), JSON.stringify(artifact.implementation));
        fs.writeFileSync(path.join(snapshot, `${artifact.id}.itt.json`), JSON.stringify(artifact.declaration));
    }
    const engine = new EvalEngine();
    await new ExecutionEngine({
        runId: 'expressions', runDir: directory, snapshotDir: snapshot,
        workdir: directory, intentName: entry, inputs: {}, evalEngine: engine, runManager: {
            update_status() {
            }
        }
    }).run();
    const events = fs.readFileSync(path.join(directory, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const outputs = events.find(event => event.event === 'run_complete').outputs;
    assert.deepEqual(outputs, {
        value: 11, mapped: ['v2', 'v3'], literal: '(as number)! satisfies { n: number }',
    });
    await engine.stop();
});

for (const mode of ['virtual', 'legacy']) test(`${mode} compiler carries prototype-named parameters through sub-intents and real Bash execution`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-prototype-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = `declare function compute_by_code(lang: string, script: string, inputs: object): Promise<{ __proto__: number }>;
export async function relay(__proto__: number): Promise<{ value: number }> { return { value: __proto__ }; }
export async function main(__proto__: number): Promise<{ value: number }> {
  const { value } = await relay(__proto__);
  const { __proto__: computed } = await compute_by_code('bash', '__proto__=$((__proto__ + 2))', { __proto__ });
  return { value: value + computed };
}`;
    const result = mode === 'virtual' ? compileProgram({
        files: {'main.ts': source},
        entries: [{file: 'main.ts', exportName: 'main'}]
    }) : undefined;
    if (result) assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const artifacts = result ? result.artifacts : compileMultiIntent(source).intents.map(intent => ({
        ...intent,
        id: intent.name
    }));
    const snapshot = path.join(directory, '.snapshot');
    fs.mkdirSync(snapshot);
    fs.mkdirSync(path.join(directory, 'io_records'));
    for (const artifact of artifacts) {
        assert.deepEqual(new Validator().validate(artifact.implementation).errors, []);
        fs.writeFileSync(path.join(snapshot, `${artifact.id}.itt.impl.json`), JSON.stringify(artifact.implementation));
        fs.writeFileSync(path.join(snapshot, `${artifact.id}.itt.json`), JSON.stringify(artifact.declaration));
    }
    const engine = new EvalEngine();
    t.after(() => engine.stop());
    await new ExecutionEngine({
        runId: 'prototype-fields', runDir: directory, snapshotDir: snapshot,
        workdir: directory, intentName: result ? result.entries[0] : 'main', inputs: JSON.parse('{"__proto__":5}'),
        executor: createCodeExecutor(directory), evalEngine: engine, runManager: {
            update_status() {
            }
        }
    }).run();
    const events = fs.readFileSync(path.join(directory, 'execution.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.find(event => event.event === 'run_complete')?.outputs, {value: 12});
});

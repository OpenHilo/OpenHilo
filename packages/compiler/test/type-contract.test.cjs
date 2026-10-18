const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram} = require('../dist');
for (const [type, kind] of [['string', 'text'], ['number', 'number'], ['boolean', 'boolean'], ['number[]', 'json'], ['Array<number>', 'json'], ['ReadonlyArray<number>', 'json'], ['readonly number[]', 'json'], ['Record<string, number>', 'json'], ['[number,string]', 'json'], ['number | null', 'json'], ['boolean | null', 'json'], ['(number)', 'number'], ['1 | 2', 'number'], ['true | false', 'boolean'], ['"a" | "b"', 'text'], ['unknown', 'json'], ['any', 'json'], ['FilePath', 'file'], ['DirPath', 'dir']]) test('consistent data contract ' + type, () => {
    const src = `declare function ask_by_human(prompt:string,x:${type}):Promise<{value:${type}}>;export async function child(x:${type}):Promise<{value:${type}}>{return {value:x};}export async function main(x:${type}):Promise<{value:${type}}>{const y:${type}=x;const a=await child(y);const b=await ask_by_human("value",y);return a;}`;
    const r = compileProgram({files: {'p.ts': src}, entries: [{file: 'p.ts', exportName: 'main'}]});
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    for (const a of r.artifacts) {
        assert.equal(a.declaration.inputs.x.kind, kind);
        assert.equal(a.declaration.outputs.value, kind);
        assert.equal(a.implementation.inputs.x.kind, kind);
        for (const n of Object.values(a.implementation.nodes)) if (n.type === 'call') {
            assert.equal(n.inputs.x.kind, kind);
            assert.equal(n.outputs.value, kind);
        }
    }
});
for (const type of ['Mystery', 'Map<string,number>', '()=>number', 'Array<()=>number>', 'Promise<number>', 'symbol', 'bigint', 'string | undefined', '{x:()=>number}', 'Array<number,string>']) test('reject unmappable contract ' + type, () => {
    const r = compileProgram({
        files: {'p.ts': `export async function main(x:${type}):Promise<{value:number}>{return {value:1};}`},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.artifacts, []);
    assert.match(JSON.stringify(r.diagnostics), /type|contract/i);
});
test('output contracts support static quoted names and reject opaque shapes', () => {
    let r = compileProgram({
        files: {'p.ts': `export async function main():Promise<{"value":number}>{return {value:1};}`},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.artifacts[0].declaration.outputs, {value: 'number'});
    for (const type of ['Mystery', 'Record<string,number>', '{value?:number}', '{[key:string]:number}']) {
        r = compileProgram({
            files: {'p.ts': `export async function main():Promise<${type}>{return {};}`},
            entries: [{file: 'p.ts', exportName: 'main'}]
        });
        assert.equal(r.ok, false, type);
    }
});
test('annotated local types reach Code input contracts independent of reverse CFG construction', () => {
    const r = compileProgram({
        files: {'p.ts': `declare function task_by_code(lang:string,script:string,inputs?:object):Promise<{}>;export async function main():Promise<{}>{const n:number=2;const values:Array<number>=[1,2];await task_by_code("bash",":",{n,values});return {};}`},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const call = Object.values(r.artifacts[0].implementation.nodes).find(n => n.type === 'call');
    assert.deepEqual(call.inputs, {n: {kind: 'number'}, values: {kind: 'json'}});
});

test('destructured local annotations cannot bypass contract validation', () => {
    for (const declaration of ['const {x}:Mystery={x:1};', 'const {x}:{x:Map<string,number>}={x:1};', 'const [x]:Array<()=>number>=[1];']) {
        const r = compileProgram({
            files: {'p.ts': 'export async function main():Promise<{value:unknown}>{' + declaration + 'return {value:x};}'},
            entries: [{file: 'p.ts', exportName: 'main'}]
        });
        assert.equal(r.ok, false, declaration);
        assert.deepEqual(r.artifacts, []);
        assert.match(JSON.stringify(r.diagnostics), /type/i);
    }
});
test('parenthesized Promise output annotations share contract mapping', () => {
    const r = compileProgram({
        files: {'p.ts': 'export async function main():(Promise<{value:number}>){return {value:1};}'},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.deepEqual(r.artifacts[0].declaration.outputs, {value: 'number'});
});

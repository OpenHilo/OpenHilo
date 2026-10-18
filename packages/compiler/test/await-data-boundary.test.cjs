const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram, validateTranslatorTs} = require('../dist');
const child = 'export async function child(n:number):Promise<{value:number}>{return {value:n};}';
for (const [name, body] of [
    ['const assignment', 'const out={value:0};out=await child(1);return out;'],
    ['unknown assignment', 'out=await child(1);return {value:1};'],
    ['compound await', 'let out=1;out+=await child(1);return {value:out};'],
    ['nested argument await', 'const r=await child(await child(1));return r;'],
    ['optional await write', 'const x={n:{value:0}};x?.n=await child(1);return {value:1};'],
    ['unknown type', 'const x:Missing=1;return {value:x};'],
    ['wrapped missing argument', 'return (await (child()));'],
    ['wrapped shadowed callable', 'const child=2;return await (child)(1);'],
    ['return unsupported function', 'return {value:()=>1};'],
    ['static scalar return', 'return 3;'],
]) test('await/data boundary ' + name, () => {
    const r = compileProgram({
        files: {'p.ts': child + 'export async function main():Promise<{value:unknown}>{' + body + '}'},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.artifacts, []);
});
test('contract diagnostics do not throw from public source validator', () => {
    const r = validateTranslatorTs('declare function task_by_ai(role:string,prompt:string,x:Missing):Promise<{value:number}>;');
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /type/i);
});

test('legacy script return-await requires an explicit workflow output contract', () => {
    const {astToITT} = require('../dist');
    const source = validateTranslatorTs('declare function value_by_human(prompt:string):Promise<{value:number}>;return await value_by_human("value");');
    assert.equal(source.ok, true, JSON.stringify(source.errors));
    assert.throws(() => astToITT(source.sourceFile, source.declarations), /declared workflow output contract/);
});

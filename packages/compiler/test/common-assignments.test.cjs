const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram} = require('../dist');
const compile = body => compileProgram({
    files: {'probe.ts': 'export async function main():Promise<{value:unknown}>{' + body + 'return {value:1};}'},
    entries: [{file: 'probe.ts', exportName: 'main'}]
});
for (const [name, body, diagnostic] of [
    ['const assignment', 'const x=1;[x]=[2];', /constant|assign/i],
    ['unknown assignment', '[unknown]=[2];', /declared|workflow|target/i],
    ['global assignment', '[Math]=[2];', /declared|workflow|target/i],
    ['computed declaration key', 'const key="x";const {[key]:x}={x:1};', /computed|static/i],
    ['computed assignment key', 'let x=0;const key="x";({[key]:x}={x:1});', /computed|static/i],
    ['member within pattern', 'const a={n:0};[a.n]=[2];', /target|pattern/i],
    ['object member within pattern', 'const a={n:0};({x:a.n}={x:2});', /target|pattern/i],
    ['nested scalar index', 'const items=[0];let i=0;items[i++]=2;', /inside an expression/i],
    ['nested scalar RHS', 'const a={n:0};let n=0;a.n=(n=2);', /inside an expression/i],
    ['pattern default scalar update', 'let other=0;const [x=(other=2)]=[];', /inside an expression/i],
    ['optional-chain target', 'const a={n:0};a?.n=2;', /optional/i],
    ['rest not last', 'const [...a,b]=[1,2];', /rest/i],
    ['rest with default', 'const {...a={}}={};', /rest/i],
    ['pattern default await', 'declare function ask_by_human(prompt:string):Promise<{ok:boolean}>;const {x=await ask_by_human("wait")}={};', /await|suspend|default/i],
]) test('common syntax rejects ' + name, () => {
    const result = compile(body);
    assert.equal(result.ok, false, name + ' compiled unexpectedly');
    assert.match(JSON.stringify(result.diagnostics), diagnostic);
});

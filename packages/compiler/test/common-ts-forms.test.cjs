const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram} = require('../dist');
const wrap = body => 'export async function main():Promise<{value:unknown}>{' + body + '}';
for (const [name, body] of [
    ['dynamic intrinsic', 'const key="max";return {value:Math[key](1,2)};'],
    ['intrinsic function alias', 'const f=Math["max"];return {value:f(1,2)};'],
    ['intrinsic wrapper escape', 'const x=(Math);return {value:x};'],
    ['constant mutation', '(Math["PI"])=2;return {value:1};'],
    ['constant update', '((Math)["PI"])++;return {value:1};'],
    ['method mutation', 'Math["max"]=1;return {value:1};'],
    ['static reflection', 'return {value:[]["constructor"]()};'],
    ['typed reflection', 'return {value:[][("constructor" as string)]()};'],
    ['dynamic callback', 'const m="map";return {value:[1][m](x=>x)};'],
    ['loop computed pattern', 'const k="x";for(const {[k]:x} of [{x:1}]){}return {value:1};'],
    ['loop reflection binding', 'for(const {constructor:x} of [{}]){}return {value:1};'],
    ['loop binding scope', 'for(const {x} of [{x:1}]){}return {value:x};'],
    ['loop const reassignment', 'for(const {x} of [{x:1}]){x=2;}return {value:1};'],
    ['loop binding temporal dead zone', 'for(const {x=x} of [{}]){}return {value:1};'],
    ['loop assignment head', 'let x=0;for(x of [1]){}return {value:1};'],
    ['reserved result helper', 'const __openhilo_return_value__=1;return {value:1};'],
]) test('common forms rejects ' + name, () => {
    const r = compileProgram({files: {'p.ts': wrap(body)}, entries: [{file: 'p.ts', exportName: 'main'}]});
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.artifacts, []);
    assert.ok(r.diagnostics.length);
});
for (const [name, body, child] of [
    ['unawaited wrapper', '(child)(1);return {value:1};', 'n:number'],
    ['wrong arity', 'const r=await (child)();return r;', 'n:number'],
    ['spread args', 'const r=await (child)(...[1]);return r;', 'n:number'],
    ['shadowed wrapper', 'const child=1;const r=await (child)(1);return r;', 'n:number'],
]) test('wrapped workflow rejects ' + name, () => {
    const r = compileProgram({
        files: {'p.ts': 'export async function child(' + child + '):Promise<{value:number}>{return {value:1};}' + wrap(body)},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.artifacts, []);
});
test('wrapped calls retain cross-file recursion detection', () => {
    const r = compileProgram({
        files: {
            'a.ts': `import {b} from './b';export async function a():Promise<{value:number}>{const r=await (b)();return r;}`,
            'b.ts': `import {a} from './a';export async function b():Promise<{value:number}>{const r=await (a)();return r;}`
        }, entries: [{file: 'a.ts', exportName: 'a'}]
    });
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.diagnostics), /circular|recurs/i);
});
test('wrapped AI calls retain source skill metadata', () => {
    const {extractAiFunctions} = require('../dist/source-skills');
    const source = `declare function task_by_ai(role:string,prompt:string,skills:string[]=['review']):Promise<{value:number}>;export async function main():Promise<{value:number}>{const r=await (task_by_ai)('worker','Check');return r;}`;
    assert.deepEqual(extractAiFunctions(source), [{
        fnName: 'task_by_ai',
        role: 'worker',
        intent: 'Check',
        currentSkills: ['review']
    }]);
    const r = compileProgram({files: {'p.ts': source}, entries: [{file: 'p.ts', exportName: 'main'}]});
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.ok(Object.values(r.artifacts[0].implementation.nodes).some(n => n.type === 'call' && n.skills?.[0] === 'review'));
});

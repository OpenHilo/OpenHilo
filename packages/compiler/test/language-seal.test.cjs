const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram} = require('../dist');
const main = body => 'export async function main():Promise<{value:unknown}>{' + body + '}';
const child = 'export async function child(n:number):Promise<{value:number}>{return {value:n};}';
const cases = [
    ['control/switch', 'switch(1){case 1:break;}return {value:1};'],
    ['control/dead switch', 'if(false){switch(1){case 1:break;}}return {value:1};'],
    ['control/do', 'do {} while(false);return {value:1};'],
    ['control/for-in', 'for(const key in {}){}return {value:1};'],
    ['control/try', 'try {return {value:1};}finally {}'],
    ['control/throw', 'throw 1;return {value:1};'],
    ['control/label', 'outer:while(true){break outer;}return {value:1};'],
    ['control/debugger', 'debugger;return {value:1};'],
    ['control/with', 'with({}){}return {value:1};'],
    ['control/callback switch', 'return {value:[1].map(n=>{switch(n){default:return 1;}})};'],
    ['binding/var', 'var n=1;return {value:n};'],
    ['binding/no initializer', 'let n;return {value:1};'],
    ['binding/const', 'const n=1;n=2;return {value:n};'],
    ['binding/scope', 'if(true){let n=1;}return {value:n};'],
    ['binding/TDZ', 'const n=m;const m=1;return {value:n};'],
    ['binding/duplicate', 'let n=1;let n=2;return {value:n};'],
    ['binding/nested update', 'let n=0;return {value:n++};'],
    ['binding/callback outer update', 'let n=0;[1].forEach(x=>{n++;});return {value:n};'],
    ['binding/computed destructuring', 'const key="n";const {[key]:n}={n:1};return {value:n};'],
    ['binding/member pattern', 'const box={n:0};[box.n]=[1];return {value:box};'],
    ['binding/for-of assignment', 'let n=0;for(n of [1]){}return {value:n};'],
    ['binding/wrapped target', 'const box={n:0};(box.n)=1;return {value:box};'],
    ['binding/optional target', 'const box={n:0};box?.n=1;return {value:box};'],
    ['call/unawaited', 'child(1);return {value:1};'],
    ['call/alias', 'const fn=child;const out=await fn(1);return out;'],
    ['call/argument await', 'return await child(await child(1));'],
    ['call/arithmetic await', 'return {value:1+(await child(1))};'],
    ['call/compound await', 'let n=1;n+=await child(1);return {value:n};'],
    ['call/spread', 'return await child(...[1]);'],
    ['call/callback workflow', 'return {value:[1].map(n=>child(n))};'],
    ['call/Promise', 'return {value:Promise.all([])};'],
    ['call/async callback', 'return {value:[1].map(async n=>n)};'],
    ['call/generator', 'return {value:[1].map(function*(){yield 1})};'],
    ['environment/require', 'return {value:require("fs")};'],
    ['environment/eval', 'return {value:eval("1")};'],
    ['environment/timer', 'setTimeout(()=>1,1);return {value:1};'],
    ['environment/intrinsic alias', 'const f=Math.max;return {value:f(1,2)};'],
    ['environment/delete', 'const x={n:1};delete x.n;return {value:x};'],
    ['environment/void', 'return {value:void 1};'],
    ['environment/class', 'class X{}return {value:1};'],
    ['data/undefined', 'return {value:undefined};'],
    ['data/sparse', 'return {value:[1,,2]};'],
    ['data/function', 'return {value:()=>1};'],
    ['data/nonfinite', 'return {value:Infinity};'],
    ['type/alias', 'type X=number;return {value:1};'],
    ['type/interface', 'interface X{n:number};return {value:1};'],
    ['type/enum', 'enum X{a};return {value:1};'],
    ['type/namespace', 'namespace X{}return {value:1};'],
    ['declaration/nested workflow', 'async function inner():Promise<{}>{return {};}return {value:1};'],
    ['data/static non-finite literal', 'const n=1e400;return {value:n};'],
    ['data/static negative non-finite literal', 'return {value:[-1e400]};'],
    ['control/for-of string literal', 'for(const c of "ab"){}return {value:1};'],
    ['control/for-of template literal', 'const s="a";for(const c of `${s}b`){}return {value:1};'],
    ['control/for-of wrapped object literal', 'for(const c of ({} as any)){}return {value:1};'],
];
for (const [name, body] of cases) test('sealed boundary rejects ' + name, () => {
    const result = compileProgram({files: {'p.ts': child + main(body)}, entries: [{file: 'p.ts', exportName: 'main'}]});
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.artifacts, []);
    assert.ok(result.diagnostics.some(d => d.message.length > 8), JSON.stringify(result));
});
for (const [name, source] of [
    ['generic workflow', 'export async function main<T>():Promise<{value:number}>{return {value:1};}'],
    ['generic executor', 'declare function ask_by_human<T>(prompt:string):Promise<{value:number}>;' + main('return await ask_by_human("x");')],
    ['generic call', child + main('return await child<string>(1);')],
    ['optional parameter', 'export async function main(n?:number):Promise<{value:number}>{return {value:1};}'],
    ['default parameter', 'export async function main(n:number=1):Promise<{value:number}>{return {value:n};}'],
    ['destructured parameter', 'export async function main({n}:{n:number}):Promise<{value:number}>{return {value:n};}'],
    ['rest parameter', 'export async function main(...n:number[]):Promise<{value:number}>{return {value:1};}'],
    ['optional output', 'export async function main():Promise<{value?:number}>{return {value:1};}'],
    ['opaque output', 'export async function main():Promise<Record<string,number>>{return {value:1};}'],
    ['unused generic', 'export async function unused<T>():Promise<{}>{return {};}' + main('return {value:1};')],
    ['default export', 'export default async function main():Promise<{value:number}>{return {value:1};}'],
    ['default and named import', 'import ignored, {child} from "./child";' + main('return await child(1);')],
    ['import attributes', 'import {child} from "./child" with {type:"json"};' + main('return await child(1);')],
]) test('sealed declaration rejects ' + name, () => {
    const result = compileProgram({
        files: {'p.ts': source, 'child.ts': child},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.artifacts, []);
    assert.ok(result.diagnostics.some(d => d.message.length > 8));
});

for (const [name, prefix] of [
    ['executor overload', 'declare function ask_by_human(prompt:string):Promise<{value:number}>;declare function ask_by_human(prompt:string,n:number):Promise<{value:number}>;'],
    ['import executor collision', 'import {child as ask_by_human} from "./child";declare function ask_by_human(prompt:string):Promise<{value:number}>;'],
    ['workflow executor collision', 'export async function ask_by_human(prompt:string):Promise<{value:number}>{return {value:1};}declare function ask_by_human(prompt:string):Promise<{value:number}>;'],
    ['human implementation body', 'function ask_by_human(prompt:string):Promise<{value:number}>{const ignored=9;return {value:ignored};}'],
    ['ai implementation body', 'function ask_by_ai(role:string,prompt:string):Promise<{value:number}>{return {value:9};}'],
    ['ambient implementation body', 'declare function ask_by_human(prompt:string):Promise<{value:number}>{return {value:9};}'],
    ['async human implementation body', 'async function ask_by_human(prompt:string):Promise<{value:number}>{return {value:9};}'],
    ['exported async code implementation body', 'export async function save_by_code(lang:string,script:string):Promise<{value:number}>{return {value:9};}'],
]) test('sealed callable identity rejects ' + name, () => {
    const result = compileProgram({
        files: {'p.ts': prefix + main('return {value:1};'), 'child.ts': child},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.artifacts, []);
    assert.ok(result.diagnostics.some(d => d.line > 0 && d.column > 0 && /duplicate|body|declare/i.test(d.message)), JSON.stringify(result.diagnostics));
});
test('registered system capability names cannot be shadowed by a workflow', () => {
    const result = compileProgram({
        files: {'p.ts': 'export async function save_by_sys():Promise<{}>{return {};}' + main('return {value:1};')},
        entries: [{file: 'p.ts', exportName: 'main'}],
        systemMethods: {save: {params: [], outputs: []}}
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
    assert.match(JSON.stringify(result.diagnostics), /duplicate|reserved/i);
});
test('debugger diagnostics name the statement', () => {
    const result = compileProgram({files: {'p.ts': main('debugger;return {value:1};')}, entries: [{file: 'p.ts', exportName: 'main'}]});
    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.diagnostics), /debugger statements are not supported/);
});
test('Code lang cannot silently default from an empty literal', () => {
    const result = compileProgram({
        files: {'p.ts': 'declare function run_by_code(lang:string,script:string):Promise<{ok:boolean}>;' + main('await run_by_code("","echo");return {value:1};')},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
    assert.match(JSON.stringify(result.diagnostics), /non-empty/);
});
test('executor prefix arguments accept transparent wrappers but stay static', () => {
    const declaration = 'declare function draft_by_ai(role:string,prompt:string,constraints?:string[]):Promise<{text:string}>;';
    const result = compileProgram({
        files: {'p.ts': declaration + main('const r=await draft_by_ai(("writer"),"draft" as string,(["short"] as const));return {value:r.text};')},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const call = Object.values(result.artifacts[0].implementation.nodes).find(node => node.type === 'call');
    assert.deepEqual([call.role, call.intent, call.constraints], ['writer', 'draft', ['short']]);
    const dynamic = compileProgram({
        files: {'p.ts': declaration + 'export async function main(t:string):Promise<{value:unknown}>{const r=await draft_by_ai((t),"draft");return {value:r.text};}'},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(dynamic.ok, false);
    assert.match(JSON.stringify(dynamic.diagnostics), /string literals/);
});
test('executor signatures require explicit declare rather than implicit overload syntax', () => {
    const result = compileProgram({
        files: {'p.ts': 'function ask_by_human(prompt:string):Promise<{value:number}>;' + main('return await ask_by_human("x");')},
        entries: [{file: 'p.ts', exportName: 'main'}]
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
    assert.match(JSON.stringify(result.diagnostics), /declare/i);
});

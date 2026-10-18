const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram} = require('../dist');
const compile = body => compileProgram({
    files: {'probe.ts': 'export async function main():Promise<{value:unknown}>{' + body + '}'},
    entries: [{file: 'probe.ts', exportName: 'main'}]
});
for (const [name, body] of [
    ['callback optional assignment', 'const a=[{n:1}];return {value:a.map(x=>{x?.n=2;return x;})};'],
    ['callback optional compound assignment', 'const a=[{n:1}];return {value:a.map(x=>{x?.n+=2;return x;})};'],
    ['callback optional update', 'const a=[{n:1}];return {value:a.map(x=>{x?.n++;return x;})};'],
    ['callback optional continued target', 'const a=[{b:{n:1}}];return {value:a.map(x=>{x?.b.n=2;return x;})};'],
    ['callback optional wrapped target', 'const a=[{n:1}];return {value:a.map(x=>{(x?.n as number)=2;return x;})};'],
    ['callback optional destructured target', 'const a=[{n:1}];return {value:a.map(x=>{({n:x?.n}={n:2});return x;})};'],
    ['callback optional array target', 'const a=[{n:1}];return {value:a.map(x=>{[x?.n]=[2];return x;})};'],
    ['callback optional loop target', 'const a=[{n:1}];return {value:a.map(x=>{for(x?.n of [2]){}return x;})};'],
    ['named self assignment', 'return {value:[1].map(function f(){f=3;return String(f);})};'],
    ['workflow reflection binding', 'const {constructor:c}=[];return {value:1};'],
    ['callback reflection assignment', 'const value=(()=>{let c=0;({constructor:c}=[]);return 1;})();return {value};'],
    ['callback computed binding assignment', 'const value=(()=>{const key="x";let c=0;({[key]:c}={x:1});return c;})();return {value};'],
    ['callback static reflection binding', 'const value=(()=>{const {"constructor":c}=[];return c.name;})();return {value};'],
    ['callback dynamic reflection binding', 'const value=(()=>{const key="constructor";const {[key]:c}=[];return c.name;})();return {value};'],
    ['callback reflection parameter', 'const value=[[]].map(({constructor:c})=>c.name);return {value};'],
    ['wrapped intrinsic mutation', 'const value=(()=>{(Math.PI)=7;return Math.PI;})();return {value};'],
    ['typed intrinsic mutation', 'const value=(()=>{(Math.PI as number)=7;return Math.PI;})();return {value};'],
    ['named callback source escape', 'const value=[1].map(function f(){return String(f)});return {value};'],
    ['instanceof', 'return {value:[] instanceof Array};'],
    ['this', 'return {value:this===null};'],
    ['globalThis', 'return {value:globalThis===null};'],
    ['unknown variable', 'return {value:notDeclared};'],
    ['unknown assignment', 'notDeclared=1;return {value:1};'],
    ['intrinsic reassignment', 'Math=1;return {value:1};'],
    ['intrinsic alias', 'const math=Math;return {value:math.PI};'],
    ['intrinsic function alias', 'const random=Math.random;return {value:random()};'],
    ['intrinsic member mutation', 'Math.random=()=>0;return {value:1};'],
    ['intrinsic argument escape', 'const v=Object.assign(Math,{extra:1});return {value:1};'],
    ['intrinsic dynamic access', 'const key="random";return {value:Math[key]()};'],
    ['prototype inspection', 'return {value:Object.getPrototypeOf([])===null};'],
    ['constructor inspection', 'return {value:[].constructor.name};'],
    ['static computed constructor', 'return {value:[]["constructor"].name};'],
    ['freeze', 'const a={};Object.freeze(a);return {value:1};'],
    ['async callback', 'const x=[1].map(async n=>n);return {value:x};'],
    ['Promise', 'return {value:Promise.resolve(1)};'],
    ['eval', 'return {value:eval("1+1")};'],
    ['require', 'return {value:require("fs")};'],
    ['Function', 'return {value:Function("return 1")()};'],
    ['Reflect', 'return {value:Reflect.ownKeys({})};'],
    ['tagged template', 'return {value:String.raw`hello`};'],
    ['class expression', 'const X=class {};return {value:1};'],
    ['generator callback', 'return {value:[1].map(function*(){yield 1;})};'],
    ['function stringify', 'return {value:String(()=>1)};'],
    ['function array escape', 'return {value:[()=>1].map(f=>String(f))};'],
    ['reserved undefined binding', 'const undefined=3;return {value:undefined};'],
    ['reserved NaN binding', 'const NaN=4;return {value:NaN};'],
    ['reserved Infinity binding', 'const {x:Infinity}={x:5};return {value:Infinity};'],
    ['static undefined', 'const x=undefined;return {value:x};'],
    ['static NaN', 'return {value:NaN};'],
    ['static infinity', 'const x=Infinity;return {value:1};'],
    ['static negative zero', 'const x=-0;return {value:1};'],
    ['static nested invalid', 'const x={missing:undefined};return {value:1};'],
    ['static undefined member', 'const a={n:1};a.n=undefined;return {value:1};'],
    ['static prototype member', 'const a={};a.__proto__={};return {value:1};'],
    ['static for initializer', 'for(let x=undefined;false;){break;}return {value:1};'],
    ['static sparse', 'const x=[1,,2];return {value:1};'],
    ['stored regexp', 'const r=/x/;return {value:1};'],
    ['stored function', 'const f=function(){return 1;};return {value:1};'],
    ['using', 'using x = {};return {value:1};'],
    ['reserved helper', 'const __openhilo_property_key__=1;return {value:1};'],
]) test('source boundary rejects ' + name, () => {
    const r = compile(body);
    assert.equal(r.ok, false, 'unsupported source compiled: ' + name);
    assert.deepEqual(r.artifacts, []);
    assert.ok(r.diagnostics.some(d => d.file === 'probe.ts' && d.line > 0 && d.column > 0), JSON.stringify(r.diagnostics));
});
for (const args of ['', '1,2', '...[1]', 'notDeclared']) test('workflow arity rejects ' + JSON.stringify(args), () => {
    const r = compileProgram({
        files: {'probe.ts': `export async function child(x:number):Promise<{value:number}>{return {value:x};}export async function main():Promise<{value:number}>{const {value}=await child(${args});return {value};}`},
        entries: [{file: 'probe.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.diagnostics), /argument|arity|input|notDeclared/i);
});

for (const [decl, call] of [
    ['declare function ask_by_human(prompt:string):Promise<{ok:boolean}>;', 'ask_by_human()'],
    ['declare function ask_by_ai(role:string,prompt:string):Promise<{ok:boolean}>;', 'ask_by_ai("worker")'],
    ['declare function ask_by_code(lang:string,script:string):Promise<{ok:boolean}>;', 'ask_by_code("javascript")'],
    ['declare function ask_by_code(lang:string,script:string,inputs?:object):Promise<{ok:boolean}>;', 'ask_by_code("javascript","",{x:notDeclared})'],
]) test('call boundary rejects ' + call, () => {
    const r = compileProgram({
        files: {'probe.ts': decl + 'export async function main():Promise<{value:number}>{await ' + call + ';return {value:1};}'},
        entries: [{file: 'probe.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.artifacts, []);
    assert.ok(r.diagnostics.some(d => d.line > 0 && d.column > 0));
});

test('immutable VM constant cannot be a workflow parameter', () => {
    const r = compileProgram({
        files: {'probe.ts': 'export async function main(undefined:number):Promise<{value:number}>{return {value:undefined};}'},
        entries: [{file: 'probe.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.artifacts, []);
    assert.match(JSON.stringify(r.diagnostics), /reserved|constant/i);
});

test('named output exemption does not allow nested prototype reflection', () => {
    const r = compileProgram({
        files: {'probe.ts': 'declare function ask_by_human(prompt:string):Promise<{constructor:object}>;export async function main():Promise<{value:number}>{const {constructor:{constructor:fn}}=await ask_by_human("x");return {value:1};}'},
        entries: [{file: 'probe.ts', exportName: 'main'}]
    });
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.diagnostics), /reflection/);
    assert.deepEqual(r.artifacts, []);
});

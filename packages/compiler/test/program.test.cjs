const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {compileProgram, compileMultiIntent, validateTranslatorTs} = require('../dist');
const source = 'export async function main(): Promise<{ value: number }> { return { value: 1 }; }';
const input = files => ({files, entries: [{file: 'main.ts', exportName: 'main'}]});

test('executor metadata rejects dynamic expressions instead of displaying source or losing constraints', () => {
    for (const [declaration, call] of [
        ['declare function ask_by_human(prompt: string): Promise<{ value: string }>;', 'ask_by_human("Hello " + name)'],
        ['declare function ask_by_human(prompt: string): Promise<{ value: string }>;', 'ask_by_human(`Hello ${name}`)'],
        ['declare function ask_by_ai(role: string, prompt: string): Promise<{ value: string }>;', 'ask_by_ai(name, "answer")'],
        ['declare function ask_by_ai(role: string, prompt: string): Promise<{ value: string }>;', 'ask_by_ai("worker", name)'],
        ['declare function ask_by_human(prompt: string, constraints?: string[]): Promise<{ value: string }>;', 'ask_by_human("answer", rules)'],
        ['declare function ask_by_human(prompt: string, constraints?: string[]): Promise<{ value: string }>;', 'ask_by_human("answer", [name])'],
        ['declare function ask_by_human(prompt: string, constraints?: string[]): Promise<{ value: string }>;', 'ask_by_human("answer", [...rules])'],
        ['declare function ask_by_code(lang: string, script: string): Promise<{ value: string }>;', 'ask_by_code("bash", name)'],
    ]) {
        const text = `${declaration}\nexport async function main(name: string, rules: string[]): Promise<{ value: string }> { const { value } = await ${call}; return { value }; }`;
        const result = compileProgram(input({'main.ts': text}));
        assert.equal(result.ok, false, call);
        assert.deepEqual(result.artifacts, [], call);
        assert.match(JSON.stringify(result.diagnostics), /literal.*business inputs/i, call);
        assert.throws(() => compileMultiIntent(text), /literal.*business inputs/i);
    }
});

test('human literal prompt and constraints retain separate dynamic business input', () => {
    const text = 'declare function ask_by_human(prompt: string, constraints?: string[], message: string): Promise<{ send: boolean }>;\nexport async function main(name: string): Promise<{ send: boolean }> { const message = name + "，你好！"; const { send } = await ask_by_human(`是否发送以下问候？`, ["请选择", `True 或 False`], message); return { send }; }';
    const result = compileProgram(input({'main.ts': text}));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const call = Object.values(result.artifacts[0].implementation.nodes).find(node => node.type === 'call');
    assert.equal(call.intent, '是否发送以下问候？');
    assert.deepEqual(call.constraints, ['请选择', 'True 或 False']);
    assert.deepEqual(call.inputsFrom, {message: '$message'});
});

test('prototype-named parameters survive declaration schemas and cross-intent argument maps', () => {
    const text = 'export async function relay(__proto__: number): Promise<{ value: number }> { return { value: __proto__ }; }\nexport async function main(__proto__: number): Promise<{ value: number }> { const { value } = await relay(__proto__); return { value }; }';
    const result = compileProgram(input({'main.ts': text}));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const main = result.artifacts.find(artifact => artifact.id === 'main.main');
    assert.equal(Object.hasOwn(main.declaration.inputs, '__proto__'), true);
    assert.deepEqual(main.declaration.inputs.__proto__, {kind: 'number', shape: {type: 'number'}});
    const call = Object.values(main.implementation.nodes).find(node => node.type === 'call');
    assert.equal(Object.hasOwn(call.inputsFrom, '__proto__'), true);
    assert.equal(call.inputsFrom.__proto__, '$__proto__');
});

test('virtual multi-export imports bind by symbol and preserve aliases and source spans', () => {
    const files = {
        'main.ts': `import { left as l, right as r } from './numbers';
export async function main(): Promise<{ value: number }> {
  const { value: a } = await l();
  const { value: b } = await r();
  return { value: a + b };
}`,
        'numbers.ts': `export async function left(): Promise<{ value: number }> { return { value: 1 }; }
export async function right(): Promise<{ value: number }> { return { value: 2 }; }`,
    };
    const result = compileProgram(input(files));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.entries, ['main.main']);
    assert.deepEqual(result.dependencies, [{from: 'main.ts', to: 'numbers.ts'}]);
    const main = result.artifacts.find(artifact => artifact.id === 'main.main');
    const callees = Object.values(main.implementation.nodes).filter(node => node.type === 'call').map(node => node.callee).sort();
    assert.deepEqual(callees, ['numbers.left', 'numbers.right']);
    for (const artifact of result.artifacts) for (const node of Object.values(artifact.implementation.nodes)) {
        const span = artifact.sourceMap[node.id];
        assert.ok(span && span.line >= 1 && span.column >= 1);
        assert.ok(files[artifact.file].slice(span.start, span.end).trim());
        if (node.type === 'call') assert.match(files[artifact.file].slice(span.start, span.end), /await/);
    }
    assert.deepEqual(compileProgram(input(Object.fromEntries(Object.entries(files).reverse()))), result);
});

test('core entry selection does not require tags, and capability methods are supplied explicitly', () => {
    assert.equal(compileMultiIntent('/** @entry */\n' + source).entries[0], 'main');
    const workflow = 'export async function main(): Promise<{ value: number }> { const { value } = await size_by_sys(); return { value }; }';
    assert.equal(compileProgram(input({'main.ts': workflow})).ok, false);
    const result = compileProgram({
        ...input({'main.ts': workflow}),
        systemMethods: {size: {params: [], outputs: [{name: 'value', kind: 'number'}]}}
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(validateTranslatorTs('await queryEntities_by_sys("X");').ok, false);
});

test('compilation performs no file reads, writes, or directory lookups', () => {
    const originals = {};
    const blocked = ['readFileSync', 'writeFileSync', 'readdirSync', 'statSync', 'existsSync'];
    for (const name of blocked) {
        originals[name] = fs[name];
        fs[name] = () => {
            throw new Error(`Unexpected filesystem operation: ${name}`);
        };
    }
    try {
        assert.equal(compileProgram(input({'main.ts': source})).ok, true);
        assert.equal(compileProgram(input({'main.ts': source.replace('value: 1', 'value: (1 as number)')})).ok, true);
    } finally {
        for (const name of blocked) fs[name] = originals[name];
    }
});

test('missing imports, private exports, aliases colliding with functions, and root escapes are diagnosed', () => {
    for (const [statement, extra, code = 'invalid_import', line = 1] of [
        ["import { missing } from './missing';", {}],
        ["import { hidden } from './other';", {'other.ts': 'async function hidden(): Promise<{}> { return {}; }'}],
        ["import { main } from './other';", {'other.ts': source}, 'invalid_source', 2],
        ["import { main as other } from '../outside';", {}],
    ]) {
        const result = compileProgram(input({'main.ts': statement + '\n' + source, ...extra}));
        assert.equal(result.ok, false);
        assert.deepEqual(result.artifacts, []);
        assert.equal(result.diagnostics[0].code, code);
        assert.equal(result.diagnostics[0].file, 'main.ts');
        assert.equal(result.diagnostics[0].line, line);
        if (code === 'invalid_source') assert.match(result.diagnostics[0].message, /Duplicate callable/);
    }
});

test('cross-file recursion is rejected before executable artifacts are emitted', () => {
    const result = compileProgram(input({
        'main.ts': "import { next } from './other'; export async function main(): Promise<{}> { await next(); return {}; }",
        'other.ts': "import { main } from './main'; export async function next(): Promise<{}> { await main(); return {}; }",
    }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.diagnostics[0].code, 'recursive_call');
});

test('invalid syntax, discarded top-level effects, duplicate functions, and non-exported entries fail closed', () => {
    for (const text of ['export async function main( {', 'let discarded = 1;\n' + source, source + '\n' + source,
        'async function main(): Promise<{}> { return {}; }']) {
        const result = compileProgram(input({'main.ts': text}));
        assert.equal(result.ok, false);
        assert.deepEqual(result.artifacts, []);
        assert.ok(result.diagnostics.length);
    }
});

test('invalid virtual inputs return diagnostics without filesystem access', () => {
    for (const value of [null, {}, {
        files: {},
        entries: []
    }, input({'../main.ts': source}), input({'a.b.ts': source}), input({'main.ts': 123})]) {
        const result = compileProgram(value);
        assert.equal(result.ok, false);
        assert.deepEqual(result.artifacts, []);
    }
});


test('unrepresentable workflow signatures fail with source diagnostics instead of losing parameter semantics', () => {
    for (const [parameters, message] of [
        ['value: number = 7', /default workflow parameters/],
        ['{ value }: { value: number }', /destructured workflow parameters/],
        ['[value]: number[]', /destructured workflow parameters/],
        ['...values: number[]', /rest workflow parameters/],
        ['value?: number', /optional workflow parameters/],
        ['this: object', /this parameters/],
        ['value: number, value: number', /duplicate workflow parameter/],
    ]) {
        const text = `export async function main(${parameters}): Promise<{ value: number }> { return { value: 1 }; }`;
        const result = compileProgram(input({'main.ts': text}));
        assert.equal(result.ok, false, parameters);
        assert.deepEqual(result.artifacts, []);
        assert.ok(result.diagnostics.some(diagnostic => message.test(diagnostic.message) && diagnostic.file === 'main.ts' && diagnostic.line === 1));
        assert.throws(() => compileMultiIntent(text), message);
    }
    const generator = compileProgram(input({'main.ts': 'export async function* main(): Promise<{}> { return {}; }'}));
    assert.equal(generator.ok, false);
    assert.match(generator.diagnostics[0].message, /generator workflow/);
});

test('executor declaration parameter validation preserves optional prefix metadata and typed inline callbacks', () => {
    const declaration = 'declare function answer_by_ai(role: string, prompt: string, constraints?: string[]): Promise<{ value: number }>;';
    assert.equal(validateTranslatorTs(declaration).ok, true);
    for (const parameters of ['{ role }: { role: string }', '...roles: string[]', 'role: string = "worker"']) {
        const result = validateTranslatorTs(`declare function answer_by_ai(${parameters}): Promise<{}>;`);
        assert.equal(result.ok, false);
    }
    const text = 'export async function main(): Promise<{ value: number }> { return { value: [1].map((value = 2): number => value)[0] }; }';
    assert.equal(compileProgram(input({'main.ts': text})).ok, true);
});

test('trailing AI skill literal defaults are metadata and survive compilation', () => {
    for (const skills of [[], ['superpowers:tdd', 'review']]) {
        const declaration = `declare function answer_by_ai(role: string, prompt: string, data: string, skills: string[] = ${JSON.stringify(skills)}): Promise<{ value: number }>;`;
        const validated = validateTranslatorTs(declaration);
        assert.equal(validated.ok, true, JSON.stringify(validated.errors));
        assert.deepEqual(validated.declarations[0].skills, skills);
        assert.deepEqual(validated.declarations[0].inputs, [{name: 'data', kind: 'text'}]);
        const result = compileProgram(input({'main.ts': declaration + '\nexport async function main(): Promise<{ value: number }> { const { value } = await answer_by_ai("worker", "answer", "data"); return { value }; }'}));
        assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
        const call = Object.values(result.artifacts[0].implementation.nodes).find(node => node.type === 'call');
        assert.deepEqual(call.skills, skills.length ? skills : undefined);
    }
});

test('AI skill defaults must be literal string arrays in trailing declaration metadata', () => {
    for (const tail of [
        'skills: string[] = other', 'skills: string[] = getSkills()',
        'skills: string[] = [other]', 'skills: string[] = [...other]',
        'skills: string[] = [1]', 'skills: string[] = [,]',
        'skills: number[] = []', 'skills = []',
        'skills: string[] = [], data: string', 'data: string = "default"',
    ]) {
        const result = validateTranslatorTs(`declare function answer_by_ai(role: string, prompt: string, ${tail}): Promise<{}>;`);
        assert.equal(result.ok, false, tail);
        assert.match(result.errors.join('\n'), /default workflow parameters/);
    }
    for (const head of ['declare function answer_by_human', 'function answer_by_ai', 'async function answer_by_ai']) {
        const body = head.startsWith('declare') ? ';' : ' { return {}; }';
        const result = validateTranslatorTs(`${head}(role: string, prompt: string, skills: string[] = []): Promise<{}>${body}`);
        assert.equal(result.ok, false, head);
        assert.match(result.errors.join('\n'), /default workflow parameters/);
    }
});

test('code calls reject unsupported inputs instead of silently dropping data', () => {
    const declaration = 'declare function step_by_code(lang: string, script: string, inputs?: object): Promise<{ exit_code: number }>;';
    for (const args of [
        '"python", "pass", data', '"python", "pass", [data]',
        '"python", "pass", { value: data }, data',
        '"python", "pass", { ...data }', '"python", "pass", { ["value"]: data }',
        '"python", "pass", { "value": data }', '"python", "pass", { get value() { return 1; } }',
    ]) {
        const compiled = compileProgram(input({'main.ts': declaration + `\nexport async function main(data: object): Promise<{ exit_code: number }> { const result = await step_by_code(${args}); return { exit_code: result.exit_code }; }`}));
        assert.equal(compiled.ok, false, `must reject silently lossy code input: ${args}`);
        assert.deepEqual(compiled.artifacts, []);
        assert.match(compiled.diagnostics.map(d => d.message).join('\n'), /code.*input|code.*argument/i);
    }
});

test('module JSON aliases expand across type-only imports and preserve source locations', () => {
 const text = `import type { Report } from './types';
declare function inspect_by_ai(role: string, prompt: string): Promise<Report>;
export async function main(): Promise<Report> {
 const result = await inspect_by_ai('researcher', 'Inspect evidence');
 return result;
}`;
 const result = compileProgram(input({ 'main.ts': text, 'types.ts': 'export type Item = { url: string; valid: boolean }; export type Report = { items: Item[]; status: string };' }));
 assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
 const artifact = result.artifacts.find(a => a.exportName === 'main');
 const call = Object.values(artifact.implementation.nodes).find(n => n.executor === 'ai');
 assert.equal(call.outputShapes.items.items.properties.url.shape.type, 'text');
 assert.ok(result.dependencies.some(e => e.from === 'main.ts' && e.to === 'types.ts'));
 for (const span of Object.values(artifact.sourceMap)) {
   assert.equal(span.line, text.slice(0, span.start).split('\n').length);
   assert.ok(span.end <= text.length);
 }
 assert.ok(Object.values(artifact.sourceMap).some(span => text.slice(span.start,span.end).includes('await inspect_by_ai')));
});

test('module alias resolution fails closed on recursive, generic, private and missing definitions', () => {
 for (const definition of [
   'export type Report = { children: Report[] };',
   'export type Report<T> = { value: T };',
   'type Report = { value: string };',
 ]) {
   const r=compileProgram(input({'main.ts':"import type { Report } from './types'; export async function main(): Promise<Report> { return {}; }",'types.ts':definition}));
   assert.equal(r.ok,false); assert.deepEqual(r.artifacts,[]);
 }
 const missing=compileProgram(input({'main.ts':"import type { Report } from './missing'; export async function main(): Promise<Report> { return {}; }"}));
 assert.equal(missing.ok,false);
 assert.throws(()=>compileMultiIntent('type Report = { value: string }; export async function main(): Promise<Report> { return {value:"x"}; }'), /type alias|explicit named fields/);
});

test('alias expansion preserves union precedence inside arrays and permits same-named data properties', () => {
 const r=compileProgram(input({'main.ts':`type Choice = 'yes' | 'no'; type Payload = { Choice: Choice[] };
 declare function inspect_by_ai(role:string,prompt:string):Promise<{ payload:Payload }>;
 export async function main():Promise<{payload:Payload}>{const r=await inspect_by_ai('a','b');return {payload:r.payload};}`}));
 assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
 const shape=Object.values(r.artifacts[0].implementation.nodes).find(n=>n.executor==='ai').outputShapes.payload;
 assert.equal(shape.properties.Choice.shape.type,'array');
 assert.equal(shape.properties.Choice.shape.items.type,'union');
});
test('unused aliases cannot hide unsupported data contracts',()=>{
 for(const declaration of ['type Bad = ()=>void;', 'type Bad = Missing;', 'type Bad = Date;']) {
  const r=compileProgram(input({'main.ts':declaration+' export async function main():Promise<{ok:boolean}>{return {ok:true};}'}));
  assert.equal(r.ok,false,declaration);
 }
});

test('module diagnostics refer to original lines after multiline alias removal',()=>{
 const text='type Data = {\n value: string;\n};\nexport async function main(data:Data = {value:"x"}):Promise<{ok:boolean}>{return {ok:true};}';
 const r=compileProgram(input({'main.ts':text}));
 assert.equal(r.ok,false);
 assert.ok(r.diagnostics.some(d=>d.file==='main.ts' && d.line===4 && /default/.test(d.message)),JSON.stringify(r.diagnostics));
});

test('type imports preserve FilePath and DirPath marker contracts without erasing them to strings',()=>{
 const r=compileProgram(input({'types.ts':'export type FilePath = string; export type DirPath = string;', 'main.ts':`import type {FilePath,DirPath} from './types';
 declare function prepare_by_code(lang:'py',script:string,inputs:{workdir:DirPath}):Promise<{report:FilePath}>;
 export async function main(workdir:DirPath):Promise<{report:FilePath}>{return await prepare_by_code('py','report = "result.txt"',{workdir});}`}));
 assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
 assert.equal(r.artifacts[0].declaration.inputs.workdir.kind,'dir');
 assert.equal(r.artifacts[0].declaration.outputs.report,'file');
});

test('alias expansion budgets apply per expansion, not to unrelated type syntax across the program', () => {
 const files = {'main.ts': 'type Data = {a:string};\nexport async function main(d:Data):Promise<{ok:boolean}>{return {ok:true};}'};
 for (let m = 0; m < 10; m++) {
  let s = '';
  for (let i = 0; i < 250; i++) s += `export async function f${i}(a:string,b:number,c:boolean,d:string[]):Promise<{ok:boolean,n:number,s:string}>{return {ok:true,n:1,s:a};}\n`;
  files[`m${m}.ts`] = s;
 }
 const r = compileProgram(input(files));
 assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

test('exponential alias expansion is still bounded and located at the use site', () => {
 let text = 'type T0 = {v:string};\n';
 for (let i = 1; i < 30; i++) text += `type T${i} = {a:T${i-1}; b:T${i-1}};\n`;
 text += 'export async function main(d:T29):Promise<{ok:boolean}>{return {ok:true};}';
 const r = compileProgram(input({'main.ts': text}));
 assert.equal(r.ok, false);
 assert.match(r.diagnostics[0].message, /complexity|size limit/);
 assert.equal(r.diagnostics[0].file, 'main.ts');
 assert.ok(r.diagnostics[0].line >= 1);
});

test('alias diagnostics carry file and original alias position', () => {
 const r = compileProgram(input({'main.ts': '\n\ntype Data = ()=>void; export async function main(d:string):Promise<{ok:boolean}>{return {ok:true};}'}));
 assert.equal(r.ok, false);
 assert.deepEqual({file: r.diagnostics[0].file, line: r.diagnostics[0].line, column: r.diagnostics[0].column}, {file: 'main.ts', line: 3, column: 13});
 const missing = compileProgram(input({'main.ts': "\nimport type {A} from './nope';\nexport async function main(d:A):Promise<{ok:boolean}>{return {ok:true};}"}));
 assert.equal(missing.diagnostics[0].file, 'main.ts');
 assert.equal(missing.diagnostics[0].line, 2);
 assert.doesNotMatch(missing.diagnostics[0].message, /^main\.ts:/);
});

test('values may share names with type aliases, matching TypeScript namespaces', () => {
 const r = compileProgram(input({'main.ts': `type v = string; type Data = {v:v};
export async function main(d:Data):Promise<{v:string, ok:boolean}>{const Data = 1; const {v: x} = d; const v = x; return {v, ok: Data === 1};}`}));
 assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
 const unbound = compileProgram(input({'main.ts': 'type Data = {v:string}; export async function main(d:Data):Promise<{ok:boolean}>{return {ok: Data === 1};}'}));
 assert.equal(unbound.ok, false);
});

test('repeated type imports produce one dependency edge', () => {
 const r = compileProgram(input({'t.ts': 'export type A={a:string}; export type B={b:string};', 'main.ts': "import type {A} from './t';\nimport type {B} from './t';\nexport async function main(d:A,e:B):Promise<{ok:boolean}>{return {ok:true};}"}));
 assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
 assert.deepEqual(r.dependencies, [{from: 'main.ts', to: 't.ts'}]);
});

test('dynamic import, optional workflow calls and __proto__ object keys are rejected', () => {
 for (const body of [
  'const u = "fs"; const x = import(u); return {ok:true};',
  'const x = import("fs"); return {ok:true};',
  'const r = await ask_by_human?.("ok?"); return {ok:r.ok};',
  'const x = {__proto__: {}}; return {ok:true};',
  'const x = {["__proto__"]: 5}; return {ok:true};',
  'const x = {"__proto__": 5}; return {ok:true};',
 ]) {
  const r = compileProgram(input({'main.ts': `declare function ask_by_human(prompt: string): Promise<{ ok: boolean }>;\nexport async function main():Promise<{ok:boolean}>{${body}}`}));
  assert.equal(r.ok, false, body);
  assert.deepEqual(r.artifacts, [], body);
 }
});

test('file-level binding analysis is shared, keeping large modules near-linear', () => {
 let text = '';
 for (let i = 0; i < 600; i++) text += `export async function f${i}(a:string):Promise<{s:string}>{const x = a; return {s:x};}\n`;
 const started = Date.now();
 const r = compileProgram({files: {'main.ts': text}, entries: [{file: 'main.ts', exportName: 'f0'}]});
 assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
 assert.equal(r.artifacts.length, 600);
 assert.ok(Date.now() - started < 8000, `compile took ${Date.now() - started}ms`);
});

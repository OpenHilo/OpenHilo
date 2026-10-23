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

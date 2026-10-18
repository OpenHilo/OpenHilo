const {test} = require('node:test');
const assert = require('node:assert/strict');
const {extractAiFunctions, rewriteSkillsDefault} = require('@openhilo/compiler/source-skills');

test('skill rewriting targets the declaration AST and escapes arbitrary literal text', () => {
    const source = `// declare function task_by_ai(skills: string[])
declare function task_by_ai(role: string, prompt: string, callback: (x: string) => void, skills: string[] = ['old']): Promise<void>;
declare function other_by_ai(skills: string[]): Promise<void>;
task_by_ai('reviewer', 'Review source', () => {});`;
    const names = ["ns:it's", 'ns:back\\slash', 'ns:line\nbreak', 'ns:$1'];
    const rewritten = rewriteSkillsDefault(source, 'task_by_ai', names);
    assert.ok(rewritten.startsWith('// declare function task_by_ai(skills: string[])'));
    assert.ok(rewritten.includes('declare function other_by_ai(skills: string[]): Promise<void>;'));
    assert.deepEqual(extractAiFunctions(rewritten)[0], {
        fnName: 'task_by_ai',
        role: 'reviewer',
        intent: 'Review source',
        currentSkills: names
    });
    assert.equal(rewriteSkillsDefault(source, 'absent_by_ai', names), source);
});

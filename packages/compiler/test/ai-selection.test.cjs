const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram, validateTranslatorTs} = require('../dist');
const decl = 'declare function produce_by_ai(role: string, prompt: string, text: string): Promise<{value: string}>;';
const body = `export async function main(text: string): Promise<{value: string}> {
 const a = await produce_by_ai('writer', 'Produce a value', text);
 const b = await (produce_by_ai)('writer', 'Produce a value', a.value);
 return b;
}`;
function compile(source) { return compileProgram({files: {'main.ts': source}, entries: [{file: 'main.ts', exportName: 'main'}]}); }
for (const [tag, expected] of [
 ['@ai.type coding\n * @ai.level pro', {type:'coding',level:'pro'}],
 ['@ai.level light', {level:'light'}], ['@ai.type default', {type:'default'}], ['',undefined],
]) test(`AI declaration selection is preserved at every call site: ${tag}`, () => {
 const result = compile(`/** ${tag} */\n${decl}\n${body}`);
 assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
 const calls = Object.values(result.artifacts[0].implementation.nodes).filter(n=>n.executor==='ai');
 assert.equal(calls.length,2);
 for(const call of calls) assert.deepEqual(call.aiSelection,expected);
});
for(const tag of ['@ai.type','@ai.type Coding','@ai.level meduim','@ai.typo coding','@ai.type coding other','@ai.type coding\n * @ai.type coding']) {
 test(`AI selection rejects invalid declaration: ${tag}`,()=>{
  const result=compile(`/** ${tag} */\n${decl}\n${body}`);
  assert.equal(result.ok,false);
  assert.match(JSON.stringify(result.diagnostics),/ai\.|AI selection/);
 });
}
for(const source of [
 `/** @ai.type coding */\n${body}`, // compound workflow
 `/** @ai.type coding */\ndeclare function choose_by_human(prompt: string): Promise<{value: string}>;`,
 `export async function main(): Promise<{value: string}> { /** @ai.type coding */ const value = 'x'; return {value}; }`,
 `export async function main(): Promise<{value: string}> { /** @ai.type coding */ return {value: 'x'}; }`,
]) test('AI tags at unsupported positions are rejected: '+source.slice(0,65),()=>{
 const result=validateTranslatorTs(source);
 assert.equal(result.ok,false);
 assert.match(result.errors.join('\n'),/AI selection|@ai/);
});
test('ordinary tags, entry and strings containing AI annotations retain their meaning',()=>{
 const result=compile(`${decl}\n/** @entry\n * @tags {"category":"demo"} */\nexport async function main(): Promise<{value:string}> { const value = '@ai.type wrong'; return {value}; }`);
 assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
 assert.deepEqual(result.artifacts[0].declaration.tags,{category:'demo'});
});
test('selection survives imported workflow, branch and loop lowering',()=>{
 const result=compileProgram({files:{'main.ts':`import {helper} from './helper'; export async function main(): Promise<{value:string}>{ return await helper(); }`,
 'helper.ts':`/** @ai.type search */\n${decl}\nexport async function helper(): Promise<{value:string}> { let value=''; for(let i=0;i<2;i++){if(i===1){const result=await produce_by_ai('researcher','Find a value',value); value=result.value;}} return {value}; }`},entries:[{file:'main.ts',exportName:'main'}]});
 assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
 const call=result.artifacts.flatMap(a=>Object.values(a.implementation.nodes)).find(n=>n.executor==='ai');
 assert.deepEqual(call.aiSelection,{type:'search'});
});
test('handwritten ITT rejects invalid selection or selection on non-AI nodes',()=>{
 const {IttValidator}=require('@openhilo/itt-contracts');
 for(const selection of [{type:'typo'},{level:'meduim'},null,{type:'coding',extra:true}]) {
  const itt={version:2,name:'bad',entry:'a',nodes:{a:{id:'a',type:'call',executor:'ai',callee:'x',inputsFrom:{},outputsTo:{},next:'END',on_failure:'ABORT',aiSelection:selection}}};
  assert.match(new IttValidator().validate(itt).errors.join('\n'),/AI selection/);
 }
 const itt={version:2,name:'bad',entry:'a',nodes:{a:{id:'a',type:'assign',assignments:{},next:'END',aiSelection:{type:'coding'}}}};
 assert.match(new IttValidator().validate(itt).errors.join('\n'),/AI selection/);
});

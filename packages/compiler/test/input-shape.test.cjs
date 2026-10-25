const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram} = require('../dist');
const {parseRunInputs} = require('@openhilo/itt-contracts/run-inputs');
function contract(type) {
  const result = compileProgram({files: {'input.ts': `export async function main(context:${type}):Promise<{value:unknown}>{return {value:context};}`}, entries: [{file:'input.ts',exportName:'main'}]});
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const artifact = result.artifacts[0];
  assert.deepEqual(artifact.declaration.inputs, artifact.implementation.inputs);
  return artifact.declaration.inputs;
}
test('compiled object fields survive declaration, implementation, CJS/ESM decoding and nested validation', async () => {
  const schema = contract('{currency:string; budget:number; enabled:boolean; skills:string[]; location:{source:FilePath;output:DirPath}; note?:string; mode:"light"|"pro"; fallback:number|null}');
  assert.equal(schema.context.shape.type, 'object');
  assert.equal(schema.context.shape.properties.note.optional, true);
  const input = {currency:'USD',budget:0,enabled:false,skills:['writing'],location:{source:'a.txt',output:'out'},mode:'pro',fallback:null,extra:'retained'};
  for (const parser of [parseRunInputs, (await import('@openhilo/itt-contracts/run-inputs')).parseRunInputs]) {
    const parse = value => parser({context:JSON.stringify(value)},schema,'typed-text-v1');
    assert.deepEqual(parse(input).context, input);
    for (const [patch, path] of [[{budget:'4'},'budget'],[{skills:[42]},'skills[0]'],[{location:{source:4,output:'out'}},'location.source'],[{note:null},'note'],[{mode:'other'},'mode'],[{fallback:false},'fallback']]) {
      assert.throws(() => parse({...input,...patch}), error => error.field === `context.${path}` && /expected/.test(error.message));
    }
    const missing = {...input}; delete missing.currency;
    assert.throws(() => parse(missing), /context.currency: required/);
  }
});
test('arrays, tuple slots/rest, records, literals and null retain declared constraints', () => {
  for (const [type,valid,invalid] of [
    ['Array<{value:number}>',[{value:2}],[{value:'2'}]],
    ['[name:string,count?:number]',['a'],['a','2']],
    ['[string,...number[]]',['a',1,2],['a',1,false]],
    ['[...number[],string]',[1,2,'a'],[1,'a',2]],
    ['Record<"a"|"b",boolean>',{a:false,b:true},{a:false}],
    ['Record<string,number>',{a:0},{a:'0'}],
    ['Record<number,string>',{'2':'a'},{wrong:'a'}],
    ['{label:string;[key:number]:number}',{label:'ok',2:4},{label:'ok',2:'wrong'}],
    ['{[key:string]:number|string;[key:number]:number}',{a:'text',2:4},{a:'text',2:'wrong'}],
    ['object',[],null],
    ['null',null,{}],['1_000',1000,10],['-1_000',-1000,-10],['0x10',16,10],['- 2',-2,2],['true',true,false]
  ]) {
    const schema=contract(type), kind=schema.context.kind;
    const parse = value => parseRunInputs({context:kind==='json'?JSON.stringify(value):String(value)},schema,'typed-text-v1');
    assert.deepEqual(parse(valid).context,valid,type);
    assert.throws(()=>parse(invalid),undefined,type);
  }
});
test('special property names are data and unknown remains explicitly unstructured', () => {
  const schema=contract('{"__proto__":string;constructor:number;data:unknown}');
  const input=JSON.parse('{"__proto__":"safe","constructor":2,"data":[null,false]}');
  assert.deepEqual(parseRunInputs({context:JSON.stringify(input)},schema,'typed-text-v1').context,input);
  assert.equal(schema.context.shape.properties.data.shape.type,'json');
});

test('optional tuple slots keep their positions, including before a rest tail', async () => {
  for (const parser of [parseRunInputs, (await import('@openhilo/itt-contracts/run-inputs')).parseRunInputs]) {
    for (const [type, valid, invalid] of [
      ['[number?,string?]', [[],[1],[1,'second']], [['wrong'],['wrong','second'],[1,2]]],
      ['[number?,...string[]]', [[],[1],[1,'a','b']], [['wrong'],['a','b'],[1,2]]],
    ]) {
      const schema = contract(type);
      for (const value of valid) assert.deepEqual(parser({context:JSON.stringify(value)},schema,'typed-text-v1').context,value);
      for (const value of invalid) assert.throws(() => parser({context:JSON.stringify(value)},schema,'typed-text-v1'), /tuple items/);
    }
  }
});

test('large rest tuples validate without recursive stack growth and retain suffix constraints', async () => {
  const numbers = Array(20000).fill(1);
  for (const parser of [parseRunInputs, (await import('@openhilo/itt-contracts/run-inputs')).parseRunInputs]) {
    for (const type of ['number[]', '[...number[]]', '[...number[],string]']) {
      const schema = contract(type), suffix = type.endsWith(',string]');
      const valid = suffix ? [...numbers,'end'] : numbers;
      assert.deepEqual(parser({context:JSON.stringify(valid)},schema,'typed-text-v1').context,valid);
      const invalid = [...valid]; invalid[10000] = false;
      assert.throws(() => parser({context:JSON.stringify(invalid)},schema,'typed-text-v1'), error => error.name === 'RunInputError');
      if (suffix) {
        for (const invalidSuffix of [numbers,[...numbers,false],[...numbers,'end',1]]) {
          assert.throws(() => parser({context:JSON.stringify(invalidSuffix)},schema,'typed-text-v1'), /tuple items/);
        }
      }
    }
  }
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {compileProgram, compileMultiIntent} = require('@openhilo/compiler');
const {validateOutputs} = require('@openhilo/ai-contracts');
const {IttValidator} = require('@openhilo/itt-contracts');
function compile(type, mode='virtual') {
  const source = `declare function plan_by_ai(role:string,prompt:string):Promise<{plan:${type}}>;
export async function main():Promise<{value:unknown}>{const r=await plan_by_ai('planner','Return the declared structure');return {value:r.plan};}`;
  const result = mode === 'virtual' ? compileProgram({files:{'main.ts':source},entries:[{file:'main.ts',exportName:'main'}]}) : null;
  if (result) assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const itt=result?result.artifacts[0].implementation:compileMultiIntent(source).intents[0].implementation;
  return {itt,node:Object.values(itt.nodes).find(n=>n.executor==='ai')};
}
for (const mode of ['virtual','legacy']) test(`${mode}: AI nested output contract survives compilation and rejects the incident shape`,()=>{
  const {node,itt}=compile('{queries:string[];urls:string[]}',mode);
  assert.ok(node.outputShapes?.plan);
  assert.deepEqual(new IttValidator().validate(itt).errors,[]);
  const check=value=>validateOutputs(node.outputs,{plan:value},node.outputShapes);
  assert.throws(()=>check({queries:[]}),/plan.urls: required/);
  assert.throws(()=>check({queries:[{query:'wrong'}],urls:[]}),/plan.queries\[0\]/);
  assert.throws(()=>check({queries:[],urls:null}),/plan.urls/);
  assert.deepEqual(check({queries:['official docs'],urls:[]}),{plan:{queries:['official docs'],urls:[]}});
});
test('nested optional, literal, nullable, tuple and record constraints retain data without coercion',()=>{
  const {node}=compile('{items:{id:string;score:number;note?:string;mode:"free"|"paid";limit:number|null}[];stats:Record<string,boolean>;pair:[string,number?]}');
  const value={items:[{id:'a',score:0,mode:'free',limit:null}],stats:{available:false},pair:['ok'],extra:'preserved'};
  const check=v=>validateOutputs(node.outputs,{plan:v},node.outputShapes);
  assert.deepEqual(check(value),{plan:value});
  for(const [field,bad] of [['score','0'],['note',null],['mode','other'],['limit',false]]) {
    assert.throws(()=>check({...value,items:[{...value.items[0],[field]:bad}]}),new RegExp(`plan.items\\[0\\].${field}`));
  }
  assert.throws(()=>check({...value,stats:{available:1}}),/plan.stats.available/);
  assert.throws(()=>check({...value,pair:['ok','bad']}),/plan.pair/);
});
test('legacy json contracts remain unstructured; malformed shapes never silently pass',()=>{
  assert.deepEqual(validateOutputs({plan:'json'},{plan:{sourceUrls:[]}}),{plan:{sourceUrls:[]}});
  assert.throws(()=>validateOutputs({plan:'json'},{plan:{}},{plan:{type:'bogus'}}),/shape/i);
  assert.throws(()=>validateOutputs({plan:'json'},{plan:{}},{other:{type:'json'}}),/shape/i);
  const {itt,node}=compile('{urls:string[]}'); node.outputShapes={plan:{type:'array'}};
  assert.ok(new IttValidator().validate(itt).errors.some(e=>/shape/i.test(e)));
});

const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {startRun,resumeRun}=require('@openhilo/runtime/run-service');
const {createDispatcher}=require('@openhilo/runtime/dispatcher');
for (const invalid of [true,false]) test(`runtime validates third-party AI output before downstream execution; invalid=${invalid}`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'output-contract-runtime-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {node}=compile('{queries:string[];urls:string[]}');
  const call=(id,next)=>({id,type:'call',executor:'code',script:':',inputsFrom:{},outputsTo:{},outputs:{},next});
  const itt={version:2,entry:'before',nodes:{before:call('before','plan'),plan:{...node,id:'plan',inputsFrom:{},outputsTo:{plan:'plan'},next:'review'},review:{id:'review',type:'call',executor:'human',intent:'Review',inputsFrom:{},outputsTo:{approved:'approved'},outputs:{approved:'boolean'},next:'after'},after:call('after','END')}};
  const entryFile=path.join(root,'task.itt.impl.json');fs.writeFileSync(entryFile,JSON.stringify(itt));
  const effects=[]; let calls=0;
  const createResources=context=>({executor:createDispatcher({workdir:context.workdir,runId:context.runId,
    codeExecutor:async n=>{effects.push(n.id);return {outputs:{}};},
    aiExecutor:{id:'fixture',capabilities:['structured_output','workspace'],async start(request){
      calls++;assert.deepEqual(request.outputShapes,node.outputShapes);
      // Deliberately bypass adapter validation to exercise the runtime trust boundary.
      return {result:Promise.resolve({status:'completed',outputs:{plan:invalid?{queries:[]}:{queries:['docs'],urls:[]}},artifacts:[]}),cancel:async()=>{}};
    }}
  })});
  const run=await startRun({intent:'task',entryFile,runsDir:path.join(root,'runs'),workdir:path.join(root,'workspace'),inputs:{},humanMode:'suspend',
    populateSnapshot({snapshotDir}){fs.copyFileSync(entryFile,path.join(snapshotDir,'task.itt.impl.json'));},createResources});
  const log=()=>fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(effects,['before']);assert.equal(calls,1);
  if(invalid){
    assert.equal(run.status,'failed');
    const failure=log().find(e=>e.event==='node_failed');
    assert.match(JSON.stringify(failure),/plan.urls: required/);
    assert.equal(failure.failure.code,'invalid_output');assert.equal(failure.failure.safeToReplay,false);
    assert.equal(log().some(e=>e.event==='node_success'&&e.node_id==='plan'),false);
    await assert.rejects(resumeRun({runDir:run.runDir,createResources}),/unsafe|safe.*replay/i);
    assert.equal(calls,1);assert.deepEqual(effects,['before']);
  }else{
    assert.equal(run.status,'suspended');
    assert.equal((await resumeRun({runDir:run.runDir,humanOutput:{approved:'true'},createResources})).status,'completed');
    assert.equal(calls,1);assert.deepEqual(effects,['before','after']);
  }
});

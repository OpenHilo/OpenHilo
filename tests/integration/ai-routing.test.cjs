const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {compileProgram}=require('@openhilo/compiler');
const {startRun,resumeRun}=require('@openhilo/runtime/run-service');
const {composition}=require('./support/ai-routing-worker.cjs');
const {currentHumanTask,readHumanSubmission}=require('@openhilo/runtime/human-tasks');
async function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'routing-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=`declare function prepare_by_ai(role:string,prompt:string):Promise<{text:string}>;
/** @ai.type coding */
declare function implement_by_ai(role:string,prompt:string,text:string):Promise<{text:string}>;
declare function decide_by_human(prompt:string):Promise<{continue:boolean}>;
export async function main():Promise<{text:string}>{
 const first=await prepare_by_ai('Assistant','Prepare');
 let text=first.text;
 for(let i=0;i<2;i++){const next=await implement_by_ai('Developer','Implement',text);text=text+':'+next.text;if(i===0){const decision=await decide_by_human('Continue?');if(!decision.continue){return {text};}}}
 return {text};
}`;
 const compiled=compileProgram({files:{'main.ts':source},entries:[{file:'main.ts',exportName:'main'}]});assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
 const entryFile=path.join(root,'main.main.itt.impl.json');fs.writeFileSync(entryFile,JSON.stringify(compiled.artifacts.find(a=>a.id==='main.main').implementation));
 const opts={intent:'main.main',entryFile,workdir:root,runsDir:path.join(root,'runs'),inputs:{},humanMode:'suspend',...composition(root),populateSnapshot:({snapshotDir})=>fs.copyFileSync(entryFile,path.join(snapshotDir,path.basename(entryFile)))};
 return {root,opts};
}
test('compiled AI routing survives a real new process, human pause and loop without replay',async t=>{
 const {root,opts}=await setup(t);const run=await startRun(opts);assert.equal(run.status,'suspended');
 const record=JSON.parse(fs.readFileSync(path.join(run.runDir,'run.json')));assert.equal(record.ai_routing_identity,opts.aiRoutingIdentity);
 const child=spawnSync(process.execPath,[path.join(__dirname,'support/ai-routing-worker.cjs'),run.runDir,root],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).status,'completed');
 const calls=fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(calls.map(c=>c.model),['basic','coder','coder']);
 const events=fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(events.find(e=>e.event==='run_complete').outputs.text,'basic:coder:coder');
});
test('configuration change or omission rejects before consuming human answers or changing run files',async t=>{
 const {root,opts}=await setup(t),run=await startRun(opts);assert.equal(run.status,'suspended');const task=currentHumanTask(run.runDir);assert.ok(task);
 const before=fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8');
 for(const aiRoutingIdentity of [undefined,composition(root,'changed').aiRoutingIdentity,'',42]){
  let resources=0;await assert.rejects(resumeRun({runDir:run.runDir,humanOutput:{continue:'true'},aiRoutingIdentity,createResources:()=>{resources++;throw Error('must not open resources')}}),/AI routing/i);
  assert.equal(resources,0);assert.equal(readHumanSubmission(run.runDir,task.taskId),undefined);assert.equal(fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8'),before);assert.equal(JSON.parse(fs.readFileSync(path.join(run.runDir,'run.json'))).status,'suspended');
 }
});
test('routing receipt cannot be forged and invalid identities create no run',async t=>{
 const {root,opts}=await setup(t);
 await assert.rejects(startRun({...opts,receipt:{ai_routing_identity:'forged'}}),/receipt/i);
 for(const aiRoutingIdentity of ['',42,null])await assert.rejects(startRun({...opts,aiRoutingIdentity}),/AI routing/i);
 assert.equal(fs.existsSync(path.join(root,'runs')),false);
});
test('durable dispatch requires the actual router identity; old executors cannot silently ignore tags',async()=>{
 const {createDispatcher}=require('@openhilo/runtime/dispatcher');const {configureAiRouting}=require('@openhilo/ai-contracts/routing');let calls=0;
 const old={id:'old',capabilities:['structured_output','workspace'],start(){calls++;throw Error('must not start')}};
 const router=configureAiRouting({default:{defaultLevel:'medium',levels:{medium:{}}}},()=>({executor:old,identity:{}}));
 const node={id:'ai',type:'call',executor:'ai',callee:'test',inputs:{},outputs:{text:'text'},outputsTo:{text:'result'}};
 for(const aiRoutingIdentity of [undefined,'other'])await assert.rejects(createDispatcher({aiExecutor:router,workdir:process.cwd(),runId:'run',aiRoutingIdentity})(node,{}),/AI routing/);
 await assert.rejects(createDispatcher({aiExecutor:old,workdir:process.cwd()})({...node,aiSelection:{type:'coding'}},{}),/model_selection/);
 await assert.rejects(createDispatcher({aiExecutor:router,workdir:process.cwd()})({...node,aiSelection:{},model:'legacy'},{}),/profile/);
 assert.equal(calls,0);
});

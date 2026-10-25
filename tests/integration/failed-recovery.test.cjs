const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {compileProgram}=require('@openhilo/compiler');
const {startRun,resumeRun}=require('@openhilo/runtime/run-service');
const {createCodeExecutor}=require('@openhilo/code-local');
const {FailableError}=require('@openhilo/runtime-contracts');
const events=dir=>fs.readFileSync(path.join(dir,'execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
for(const actor of ['ai','code']) test(`${actor} failure in nested loop resumes after Human without repeating completed file effects`,async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hilo-failed-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=`
 declare function record_by_code(lang:string,script:string,inputs:{i:number}):Promise<{value:number}>;
 declare function compute_by_ai(role:string,prompt:string,i:number):Promise<{value:number}>;
 declare function approve_by_human(prompt:string):Promise<{ok:boolean}>;
 async function nested(i:number):Promise<{value:number}>{
 ${actor==='ai'?`return await compute_by_ai('Worker','Compute the item',i);`:`return await record_by_code('python',"exec(open('work.py').read())",{i});`}
 }
 export async function main():Promise<{total:number}>{
 await record_by_code('python',"open('before.txt','a').write('once\\\\n'); value=1",{i:-1});
 const approval=await approve_by_human('Continue?');
 let total=0;
 for(let i=0;i<3;i++){const x=await nested(i);total+=x.value;}
 return {total};
 }`;
 const c=compileProgram({files:{'main.ts':source},entries:[{file:'main.ts',exportName:'main'}]});assert.equal(c.ok,true,JSON.stringify(c.diagnostics));
 const entry=c.artifacts.find(a=>a.id==='main.main');const entryFile=path.join(root,'main.main.itt.impl.json');fs.writeFileSync(entryFile,JSON.stringify(entry.implementation));
 const script=`open('attempts.txt','a').write(str(i)+'\\n')\nif i==1 and not __import__('os').path.exists('fixed'): raise ValueError('Fix required')\nvalue=i+1\n`;
 fs.writeFileSync(path.join(root,'work.py'),script);
 const code=createCodeExecutor(root);let failedOnce=false;const aiCalls=[];
 const createResources=()=>({executor:async(node,inputs,ctx)=>{
  if(node.executor==='code')return code(node,inputs,ctx);
  assert.equal(node.executor,'ai');aiCalls.push(inputs.i);
  ctx?.onAiEvent?.({type:'progress',message:'Working on item '+inputs.i,taskId:'task',attemptId:'attempt',sequence:aiCalls.length,timestamp:new Date().toISOString()});
  if(inputs.i===1&&!failedOnce){failedOnce=true;throw new FailableError('Provider failed',{code:'outcome_unknown',message:'Lost connection',retryable:false,safeToReplay:false});}
  return {outputs:{value:inputs.i+1}};
 }});
 const start=await startRun({intent:'main.main',entryFile,workdir:root,runsDir:path.join(root,'runs'),inputs:{},humanMode:'suspend',createResources,populateSnapshot({snapshotDir}){for(const a of c.artifacts){fs.writeFileSync(path.join(snapshotDir,a.id+'.itt.impl.json'),JSON.stringify(a.implementation));fs.writeFileSync(path.join(snapshotDir,a.id+'.itt.json'),JSON.stringify(a.declaration));}}});
 assert.equal(start.status,'suspended');
 const failed=await resumeRun({runDir:start.runDir,humanOutput:{ok:'true'},createResources});assert.equal(failed.status,'failed');
 const log=events(start.runDir);assert.equal(log.at(-1).event,'suspended_state');const id=log.findLast(e=>e.event==='run_failed').node_run_id;
 await assert.rejects(resumeRun({runDir:start.runDir,retryFailedNode:'stale',createResources}),/changed/);
 if(actor==='ai')await assert.rejects(resumeRun({runDir:start.runDir,createResources}),/unsafe/);
 fs.writeFileSync(path.join(root,'fixed'),'yes');
 assert.equal((await resumeRun({runDir:start.runDir,retryFailedNode:id,createResources})).status,'completed');
 assert.equal(fs.readFileSync(path.join(root,'before.txt'),'utf8').match(/once/g).length,1);
 assert.deepEqual(actor==='ai'?aiCalls:fs.readFileSync(path.join(root,'attempts.txt'),'utf8').trim().split('\n').map(Number),[0,1,1,2]);
 const done=events(start.runDir);assert.deepEqual(done.findLast(e=>e.event==='run_complete').outputs,{total:6});
 assert.equal(done.filter(e=>e.event==='node_suspended').length,1);
 await assert.rejects(resumeRun({runDir:start.runDir,retryFailedNode:id,createResources}),/current failed/);
 if(actor==='ai')assert.ok(done.some(e=>e.event==='ai_progress'&&e.message==='Working on item 1'));
});
test('invalid Code output preserves raw fields and process streams as diagnostics, never as successful outputs',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hilo-output-diagnostics-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'task.itt.impl.json');fs.writeFileSync(file,JSON.stringify({version:2,entry:'code',nodes:{code:{id:'code',type:'call',executor:'code',lang:'python',script:"value={'unexpected':42}; print('VISIBLE_STDOUT'); __import__('sys').stderr.write('VISIBLE_STDERR')",inputsFrom:{},outputsTo:{value:'value'},outputs:{value:'number'},next:'END'}}}));
 const result=await startRun({intent:'task',entryFile:file,workdir:root,runsDir:path.join(root,'runs'),inputs:{},populateSnapshot({snapshotDir}){fs.copyFileSync(file,path.join(snapshotDir,path.basename(file)));},createResources:()=>({executor:createCodeExecutor(root)})});
 assert.equal(result.status,'failed');const log=events(result.runDir);const failure=log.find(e=>e.event==='node_failed');
 assert.equal(failure.diagnostics.stdout,'VISIBLE_STDOUT\n');assert.equal(failure.diagnostics.stderr,'VISIBLE_STDERR');assert.equal(failure.diagnostics.exitCode,0);
 assert.deepEqual(JSON.parse(failure.diagnostics.rawOutputs).outputs,{value:{unexpected:42}});
 assert.equal(log.some(e=>e.event==='node_success'),false);
});

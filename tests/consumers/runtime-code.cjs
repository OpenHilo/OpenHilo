const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {startRun}=require('@openhilo/runtime/run-service');
const {createDispatcher}=require('@openhilo/runtime/dispatcher');
const {createCodeExecutor}=require('@openhilo/code-local');
(async()=>{
 const workdir=path.resolve('workspace');fs.mkdirSync(workdir);
 const entryFile=path.join(workdir,'sum.itt.impl.json');
 fs.writeFileSync(entryFile,JSON.stringify({version:2,entry:'python',outputs:{answer:'answer'},nodes:{python:{id:'python',type:'call',executor:'code',lang:'python',script:'answer = count * 2',inputsFrom:{count:'3'},outputsTo:{answer:'answer'},outputs:{answer:'number'},next:'END'}}}));
 let result;
 const run=await startRun({intent:'sum',entryFile,workdir,runsDir:path.join(workdir,'runs'),inputs:{},populateSnapshot:({snapshotDir})=>fs.copyFileSync(entryFile,path.join(snapshotDir,path.basename(entryFile))),onEvent:e=>{if(e.event==='run_complete')result=e.outputs;},createResources:({runId,workdir})=>({executor:createDispatcher({runId,workdir,codeExecutor:createCodeExecutor(workdir)})})});
 assert.equal(run.status,'completed');assert.deepEqual(result,{answer:6});
 const bash=await createCodeExecutor(workdir)({id:'bash',type:'call',executor:'code',script:'value=$((count + 1))',inputsFrom:{},outputsTo:{},outputs:{value:'number'},next:'END'},{count:2});assert.equal(bash.outputs.value,3);
})().catch(e=>{console.error(e);process.exitCode=1;});

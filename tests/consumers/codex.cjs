const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {CodexTaskExecutor}=require('@openhilo/ai-codex');
assert.throws(()=>require.resolve('react'),{code:'MODULE_NOT_FOUND'});
(async()=>{
 const dir=path.resolve('workspace');fs.mkdirSync(dir);
 // Transport passes `app-server --listen stdio://`. Let the selected Node
 // interpret that script, so a freshly copied fixture is never OS-executed.
 fs.copyFileSync(path.resolve('fixtures/codex.cjs'),path.join(dir,'app-server'));
 const executor=new CodexTaskExecutor({cliPath:process.execPath,timeoutMs:5000});
 const began=Date.now(),events=[];
 const execution=await executor.start({version:1,taskId:'consumer',instruction:'ok',inputs:{},output:{answer:'text',data:'json'},requiredCapabilities:[]},{attemptId:'one',signal:new AbortController().signal,workspace:{id:'consumer',uri:pathToFileURL(dir).href},onEvent(event){
  if(event.type==='phase')events.push({ms:Date.now()-began,phase:event.phase});
  if(event.type==='health')events.push({ms:Date.now()-began,phase:event.health.phase,condition:event.health.condition});
 }});
 const result=await execution.result;assert.equal(result.status,'completed',JSON.stringify({result,events}));assert.equal(result.outputs.answer,'ok');await executor.releaseSession?.(result.session);
 const studio=await import('@openhilo/studio-contracts/ai-config');assert.ok(Object.keys(studio).length);
 await import('@openhilo/studio-contracts');
})().catch(e=>{console.error(e);process.exitCode=1;});

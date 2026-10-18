const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {configureAiRouting}=require('@openhilo/ai-contracts/routing');const {createTaskExecution}=require('@openhilo/ai-contracts');
const {compileProgram}=require('@openhilo/compiler');const {createDispatcher}=require('@openhilo/runtime/dispatcher');const {startRun}=require('@openhilo/runtime/run-service');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'route-consumer-'));
 try{
 const router=configureAiRouting({default:{defaultLevel:'medium',levels:{medium:{}}}},()=>({identity:{kind:'local-fixture'},executor:{id:'local-fixture',capabilities:['structured_output','workspace'],async start(req,host){return createTaskExecution(req,host,async()=>({status:'completed',outputs:{text:'routed'},artifacts:[]}))}}}));
 const compiled=compileProgram({files:{'main.ts':`/** @ai.type default */\ndeclare function write_by_ai(role:string,prompt:string):Promise<{text:string}>;export async function main():Promise<{text:string}>{return await write_by_ai('Writer','One word');}`},entries:[{file:'main.ts',exportName:'main'}]});assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
 const entryFile=path.join(root,'main.main.itt.impl.json');fs.writeFileSync(entryFile,JSON.stringify(compiled.artifacts[0].implementation));
 const run=await startRun({aiRoutingIdentity:router.id,intent:'main.main',entryFile,inputs:{},runsDir:path.join(root,'runs'),workdir:root,populateSnapshot:({snapshotDir})=>fs.copyFileSync(entryFile,path.join(snapshotDir,path.basename(entryFile))),createResources:c=>({executor:createDispatcher({runId:c.runId,workdir:root,aiRoutingIdentity:c.aiRoutingIdentity,aiExecutor:router})})});assert.equal(run.status,'completed');
 for(const name of ['@openhilo/ai-codex','@openhilo/ai-sdk'])assert.throws(()=>require.resolve(name),{code:'MODULE_NOT_FOUND'});
 console.log('Independent compiler/runtime routing with no provider packages passed');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});

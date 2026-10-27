const fs=require('node:fs'),path=require('node:path');
const {createDispatcher}=require('@openhilo/runtime/dispatcher');
const {currentHumanTask}=require('@openhilo/runtime/human-tasks');
const {createExecutor}=require('./config.cjs');
function composition(config) {
 const aiExecutor=createExecutor(config);
 return {aiRoutingIdentity:aiExecutor.id,humanMode:'suspend',createResources:context=>({executor:createDispatcher({workdir:context.workdir,runId:context.runId,aiRoutingIdentity:context.aiRoutingIdentity,aiExecutor})}),onEvent:event=>{
  if(event.event==='node_pending' && event.executor==='ai')console.error('AI is working:',event.node_id);
  if(['run_failed','run_abort'].includes(event.event))console.error('Run stopped:',event.reason);
 }};
}
function display(run){console.log(JSON.stringify(run,null,2));if(run.status==='suspended'){
 const task=currentHumanTask(run.runDir);
 if(task)console.log(`\n${task.prompt}\n${Object.entries(task.inputs).map(([name,value])=>`${name}: ${typeof value==='string'?value:JSON.stringify(value)}`).join('\n')}\n`);
 console.log(`Waiting for your choice. Resume with: node examples/model-routing/resume.cjs --run-dir ${JSON.stringify(run.runDir)} --continue true|false (add the same --config if you used one)`);
 }else if(run.status==='completed'){
 const events=fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse);console.log(JSON.stringify(events.find(e=>e.event==='run_complete').outputs,null,2));
 }else process.exitCode=1;return run;}
module.exports={composition,display};

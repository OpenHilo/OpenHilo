const fs = require('node:fs');
const path = require('node:path');
const {configureAiRouting} = require('@openhilo/ai-contracts/routing');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
function composition(root, model='coder') {
 const router=configureAiRouting({default:{defaultLevel:'medium',levels:{medium:{model:'basic'}}},coding:{defaultLevel:'pro',levels:{pro:{model}}}},config=>({identity:config,executor:{id:'fixture:'+config.model,capabilities:['structured_output','workspace'],async start(req,host){
  fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({model:config.model,inputs:req.inputs})+'\n');
  return createTaskExecution(req,host,async()=>({status:'completed',outputs:{text:config.model},artifacts:[]}));
 }}}));
 return {aiRoutingIdentity:router.id,createResources:context=>({executor:createDispatcher({workdir:context.workdir,runId:context.runId,aiRoutingIdentity:context.aiRoutingIdentity,aiExecutor:router})})};
}
module.exports={composition};
if(require.main===module) require('@openhilo/runtime/run-service').resumeRun({runDir:process.argv[2],humanOutput:{continue:'true'},...composition(process.argv[3])}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1});

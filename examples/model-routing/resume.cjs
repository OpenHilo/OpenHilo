const path=require('node:path');const {parseArgs}=require('node:util');
const {resumeRun}=require('@openhilo/runtime/run-service');const {composition,display}=require('./host.cjs');const {readRunReceipt}=require('../lib/resources.cjs');
async function main(){const {values}=parseArgs({options:{'run-dir':{type:'string'},config:{type:'string'},continue:{type:'string'}}});
 if(!values['run-dir']||!['true','false'].includes(values.continue))throw Error('Provide --run-dir PATH --continue true|false');
 const runDir=path.resolve(values['run-dir']);if(readRunReceipt(runDir).example!=='model-routing')throw Error('Not a model-routing run');
 return display(await resumeRun({...composition(path.resolve(values.config??path.join(__dirname,'ai.config.json'))),runDir,humanOutput:{continue:values.continue}}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});

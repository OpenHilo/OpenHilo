const fs=require('node:fs'),path=require('node:path');
const {parseArgs}=require('node:util');const {startRun}=require('@openhilo/runtime/run-service');
const {compileFiles}=require('../lib/compile.cjs');const {composition,display}=require('./host.cjs');
async function main(){
 const {values}=parseArgs({options:{output:{type:'string'},config:{type:'string'},topic:{type:'string',default:'A reading list'}}});
 if(!values.output)throw Error('Provide --output NEW_DIRECTORY');
 const output=path.resolve(values.output),config=path.resolve(values.config??path.join(__dirname,'ai.config.json'));const options=composition(config);
 if(fs.existsSync(output))throw Error(`Output already exists; choose a new directory: ${output}`);
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);const workdir=path.join(output,'workspace');fs.mkdirSync(workdir);
 const compiled=compileFiles({files:{'workflow.ts':path.join(__dirname,'workflow.ts')},entries:[{file:'workflow.ts',exportName:'main'}],outputDir:path.join(output,'artifacts')});
 return display(await startRun({...options,intent:'workflow.main',entryFile:compiled.entryFile,workdir,runsDir:path.join(output,'runs'),inputs:{topic:values.topic},receipt:{example:'model-routing'},populateSnapshot:({snapshotDir})=>fs.cpSync(compiled.artifactsDir,snapshotDir,{recursive:true})}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});

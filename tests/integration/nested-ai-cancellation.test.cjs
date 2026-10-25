const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {startRun, resumeRun} = require('@openhilo/runtime/run-service');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createCodeExecutor} = require('@openhilo/code-local');

const code = (id, next) => ({id, type:'call', executor:'code', lang:'python',
    script:`with open('effects', 'a') as f: f.write('${id}' + chr(10))`,
    inputsFrom:{}, outputsTo:{}, outputs:{}, next});
const call = (id, callee, next) => ({id, type:'call', executor:'intent', callee, inputsFrom:{}, outputsTo:{}, outputs:{}, next, on_failure:'fallback'});

for (const outcome of ['cancelled', 'failed']) test(`nested AI ${outcome} after Human resume keeps cancellation distinct from failure recovery`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-ai-cancel-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    const files = {
        main: {version:2, entry:'before', nodes:{
            before:code('before','human'),
            human:{id:'human',type:'call',executor:'human',intent:'Approve',inputsFrom:{},outputsTo:{approved:'approved'},outputs:{approved:'boolean'},next:'middle'},
            middle:call('middle','middle','after'), fallback:code('fallback','after'), after:code('after','END'),
        }},
        middle: {version:2,entry:'leaf',nodes:{leaf:call('leaf','leaf','END'),fallback:code('fallback','END')}},
        leaf: {version:2,entry:'ai',nodes:{
            ai:{id:'ai',type:'call',executor:'ai',intent:'Task',inputsFrom:{},outputsTo:{},outputs:{},next:'END',on_failure:'fallback'},
            fallback:code('fallback','END'),
        }},
    };
    for(const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(root,name+'.itt.impl.json'),JSON.stringify(value));
    let calls=0, closed=0;
    const createResources = context => ({executor:createDispatcher({workdir:root,runId:context.runId,
        codeExecutor:createCodeExecutor(root), aiExecutor:{id:'offline',capabilities:['structured_output','workspace'],async start(){
            calls++;
            return {result:Promise.resolve(outcome==='cancelled'
                ? {status:'cancelled',reason:'Explicit user stop'}
                : {status:'failed',error:{code:'executor_failed',message:'Provider failure',safeToReplay:false,retryable:false}})};
        }}}), close(){closed++;}});
    const run = await startRun({intent:'main',entryFile:path.join(root,'main.itt.impl.json'),workdir:root,runsDir:path.join(root,'runs'),inputs:{},createResources,
        populateSnapshot({snapshotDir}){for(const name of Object.keys(files))fs.copyFileSync(path.join(root,name+'.itt.impl.json'),path.join(snapshotDir,name+'.itt.impl.json'));}});
    assert.equal(run.status,'suspended');
    const resumed=await resumeRun({runDir:run.runDir,humanOutput:{approved:'true'},createResources});
    assert.equal(resumed.status,outcome==='cancelled'?'aborted':'completed', fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8')); 
    assert.equal(calls,1, fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8'));assert.equal(closed,2);
    assert.equal(fs.existsSync(path.join(run.runDir,'run.lock')),false);
    assert.equal(fs.readFileSync(path.join(root,'effects'),'utf8'),outcome==='cancelled'?'before\n':'before\nfallback\nafter\n');
    const events=fs.readFileSync(path.join(run.runDir,'execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e=>e.event==='node_pending'&&e.node_id==='before').length,1);
    assert.equal(events.filter(e=>e.event==='node_success'&&e.outputs?.approved===true).length,1);
    if(outcome==='cancelled'){
        assert.equal(events.at(-1).event,'run_abort');
        const resumedEvents=events.slice(events.findLastIndex(e=>e.event==='run_resume'));
        assert.equal(resumedEvents.some(e=>['run_failed','suspended_state','run_complete'].includes(e.event)),false);
        for(const extra of [{},{humanOutput:{approved:'true'}},{retryFailedNode:events.findLast(e=>e.event==='node_failed').node_run_id}]){
            await assert.rejects(resumeRun({runDir:run.runDir,...extra,createResources(){throw Error('MUST NOT ACQUIRE');}}),/no suspended state|current failed run/i);
        }
    }
});

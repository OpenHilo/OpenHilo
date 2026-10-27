const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTaskExecution,assertCanStart} = require('../dist');
let configureAiRouting;
try { ({configureAiRouting}=require('../dist/routing')); } catch(e) { if(e.code!=='MODULE_NOT_FOUND')throw e; }
const routes=()=>({default:{defaultLevel:'medium',levels:{medium:{model:'basic'},pro:{model:'smart'}}},coding:{defaultLevel:'pro',levels:{light:{model:'fast'},pro:{model:'coder'}}}});
function request(selection) {return {version:1,taskId:'task',instruction:'Work',inputs:{text:'hello'},output:{value:'text'},requiredCapabilities:[],...(selection===undefined?{}:{aiSelection:selection})};}
function host(events=[]) {return {attemptId:'attempt',signal:new AbortController().signal,onEvent:event=>events.push(event)};}
function factory(c) {
 const session={executorId:`provider-${c.model}`,version:1,opaqueId:'context'};
 const executor={id:session.executorId,capabilities:['structured_output','continue','questions'],
  async start(req,h) {
   assertCanStart(req,h,this.id,this.capabilities);
   assert.equal(req.aiSelection,undefined);
   assert.equal(req.requiredCapabilities.includes('model_selection'),false);
   const execution=createTaskExecution(req,h,async ctx=>{
    if(c.question) await ctx.ask({id:'q',prompt:'Continue?',answer:'text'});
    return {status:'completed',outputs:{value:c.model},artifacts:[],session};
   });
   Object.defineProperty(execution,'session',{get:()=>session});
   return execution;
  },
  async releaseSession(s){assert.deepEqual(s,session);c.released?.push(s);}
 };
 return {executor,identity:{model:c.model,question:!!c.question}};
}
function routing(r=routes(),f=factory){assert.equal(typeof configureAiRouting,'function','routing public API must exist');return configureAiRouting(r,f);}

test('four default rules route to distinct configured results',async()=>{
 const router=routing();
 for(const [selection,want] of [[undefined,'basic'],[{type:'coding'},'coder'],[{level:'pro'},'smart'],[{type:'coding',level:'light'},'fast'],[{type:'default'},'basic']]){
  const execution=await router.start(request(selection),host());assert.equal((await execution.result).outputs.value,want);
 }
});
test('explicit missing route rejects before executor start and never falls back',async()=>{
 let calls=0;const router=routing(routes(),c=>{const t=factory(c);const original=t.executor.start;t.executor.start=function(...args){calls++;return original.apply(this,args)};return t});
 for(const selection of [{type:'search'},{type:'coding',level:'max'}])await assert.rejects(router.start(request(selection),host()),/search|coding\/max/);
 assert.equal(calls,0);
});
test('direct route structure rejects references, arrays, invalid defaults and unknown fields before factory',()=>{
 assert.equal(typeof configureAiRouting,'function');
 for(const r of [{}, {default:{defaultLevel:'max',levels:{medium:{model:'a'}}}}, {default:{defaultLevel:'medium',levels:{medium:'target'}}}, {default:{defaultLevel:'medium',levels:{medium:[{model:'a'}]}}}, {...routes(),typo:{defaultLevel:'pro',levels:{pro:{}}}}, {default:{...routes().default,selected:'a'}}]){
  let created=0;assert.throws(()=>routing(r,c=>{created++;return factory(c)}));assert.equal(created,0);
 }
});
test('concurrent calls remain isolated and construction input mutations do not alter routing',async()=>{
 const r=routes(),router=routing(r);r.coding.levels.pro.model='changed';r.default.defaultLevel='pro';
 const results=await Promise.all([request({type:'coding'}),request()].map(async req=>(await(await router.start(req,host())).result).outputs.value));
 assert.deepEqual(results,['coder','basic']);
 const same=routing({coding:routes().coding,default:{levels:{pro:{model:'smart'},medium:{model:'basic'}},defaultLevel:'medium'}});
 assert.equal(router.id,same.id);assert.notEqual(router.id,routing(r).id);
});
test('profile cannot override a routed target and old executors reject selection',async()=>{
 const router=routing();await assert.rejects(router.start({...request(),profile:'alternate'},host()),/profile/);
 assert.throws(()=>assertCanStart(request({type:'coding'}),host(),'old',['structured_output']),/selection|model_selection/);
});
test('capability of another target never authorizes unsupported target',async()=>{
 let calls=0;const router=routing(routes(),c=>{const t=factory(c);if(c.model==='coder')t.executor.capabilities.push('tools');const start=t.executor.start;t.executor.start=function(...args){calls++;return start.apply(this,args)};return t;});
 await assert.rejects(router.start(request(),{...host(),tools:{definitions:[],invoke:async()=>({ok:true,output:null})}}),/tools/);assert.equal(calls,0);
});
test('session wrapper is consistent across handle, terminal and result and resumes on original target',async()=>{
 const events=[],released=[];const r={default:{defaultLevel:'medium',levels:{medium:{model:'basic',released}}}};
 const router=routing(r,c=>factory({...c,released}));const execution=await router.start(request(),host(events));
 const session=execution.session;assert.equal(session.executorId,router.id);
 const result=await execution.result;assert.deepEqual(result.session,session);assert.deepEqual(events.at(-1).result,result);
 await router.releaseSession(session);assert.equal(released.length,1);
 const restored=routing(r);const next=await restored.start({...request(),continuation:session},host());assert.equal((await next.result).outputs.value,'basic');
 await assert.rejects(restored.start({...request({level:'pro'}),continuation:session},host()),/route|pro/);
 await assert.rejects(restored.reconnect(session,host()),/reconnect/);
 await assert.rejects(restored.releaseSession({...session,opaqueId:'garbage'}),/session/i);
 await assert.rejects(restored.releaseSession({...session,executorId:'other'}),/session|identity/i);
});
test('questions and cancellation use actual child lifecycle without duplicate terminal events',async()=>{
 const events=[],router=routing({default:{defaultLevel:'medium',levels:{medium:{model:'basic',question:true}}}});
 const ex=await router.start(request(),host(events));
 assert.equal(ex.state,'waiting_for_input');assert.equal(await ex.answer('q','yes'),'accepted');assert.equal(await ex.answer('q','yes'),'duplicate');
 assert.equal((await ex.result).status,'completed');assert.equal(events.filter(e=>e.type==='terminal').length,1);
 const second=await router.start(request(),host());await second.cancel('user stopped');assert.equal((await second.result).status,'cancelled');
});
test('target failure is not converted to replayable failure or retried',async()=>{
 let calls=0;const failure={code:'outcome_unknown',message:'effect uncertain',retryable:false,safeToReplay:false};
 const router=routing(routes(),c=>({identity:{model:c.model},executor:{id:c.model,capabilities:['structured_output'],async start(r,h){calls++;return createTaskExecution(r,h,async()=>({status:'failed',error:failure}));}}}));
 const result=await(await router.start(request(),host())).result;assert.deepEqual(result.error,failure);assert.equal(calls,1);
});
test('a malformed target session settles as a failed result instead of rejecting',async()=>{
 const events=[];
 const router=routing({default:{defaultLevel:'medium',levels:{medium:{}}}},c=>({identity:c,executor:{id:'bad-session',capabilities:['structured_output'],async start(req,h){return createTaskExecution(req,h,async()=>({status:'completed',outputs:{value:'x'},artifacts:[],session:{executorId:'someone-else',version:1,opaqueId:'s'}}));}}}));
 const result=await(await router.start(request(),host(events))).result;
 assert.equal(result.status,'failed');assert.equal(result.error.code,'executor_failed');assert.equal(result.error.safeToReplay,false);
 assert.deepEqual(events.at(-1).result,result);
});
test('the cooperative helper enforces nested outputShapes at completion',async()=>{
 const req={...request(),output:{plan:'json'},outputShapes:{plan:{type:'object',properties:{urls:{shape:{type:'array',items:{type:'text'}}}}}}};
 const result=await createTaskExecution(req,host(),async()=>({status:'completed',outputs:{plan:{urls:[1]}},artifacts:[]})).result;
 assert.equal(result.status,'failed');assert.equal(result.error.code,'invalid_output');assert.match(result.error.message,/plan\.urls/);
});
test('search is a routing label, with arbitrary typed business outputs and no imposed tools or citations',async()=>{
 const output={found:'boolean',count:'number',summary:'text'};
 const router=routing({default:{defaultLevel:'medium',levels:{medium:{}}},search:{defaultLevel:'light',levels:{light:{}}}},c=>({identity:c,executor:{id:'search-fixture',capabilities:['structured_output'],async start(req,h){assert.deepEqual(req.requiredCapabilities,[]);return createTaskExecution(req,h,async()=>({status:'completed',outputs:{found:true,count:2,summary:'two matches'},artifacts:[]}))}}}));
 const result=await(await router.start({...request({type:'search'}),output},host())).result;assert.deepEqual(result.outputs,{found:true,count:2,summary:'two matches'});
});

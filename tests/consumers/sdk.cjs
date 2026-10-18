const assert=require('node:assert/strict');
const OpenAI=require('openai').default;
const Anthropic=require('@anthropic-ai/sdk').default;
const {SdkTaskExecutor}=require('@openhilo/ai-sdk');
const {createToolHost}=require('@openhilo/tool-host');
const {transport,response}=require('./fixtures/sdk-transport.cjs');
(async()=>{
 for(const provider of ['openai','anthropic']){
  let invoked=0;const tools=createToolHost([{name:'lookup',description:'one item',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},readOnly:true,async handler({id}){invoked++;assert.equal(id,'one');return {title:'Garden'};}}]);
  const fetcher=transport(provider,[response(provider,[{id:'lookup-1',name:'lookup',args:{id:'one'}}]),response(provider,[{id:'done',name:'finish_task',args:{summary:'Garden'}}])]);
  const client=provider==='openai'?new OpenAI({apiKey:'fixture-only',fetch:fetcher.fetch,maxRetries:0}):new Anthropic({apiKey:'fixture-only',fetch:fetcher.fetch,maxRetries:0});
  const executor=new SdkTaskExecutor({profiles:{test:{provider,model:'fixture',client}},defaultProfile:'test'});
  const execution=await executor.start({version:1,taskId:'consumer',instruction:'Find one',inputs:{id:'one'},output:{summary:'text'},requiredCapabilities:['tools']},{attemptId:provider,signal:new AbortController().signal,tools,onEvent(){}});
  const result=await execution.result;assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(result.outputs.summary,'Garden');assert.equal(invoked,1);await executor.releaseSession(result.session);
 }
 for(const missing of ['@openhilo/ai-codex','@openhilo/runtime','@openhilo/compiler','@openhilo/server','react'])assert.throws(()=>require.resolve(missing),{code:'MODULE_NOT_FOUND'});
})().catch(e=>{console.error(e);process.exitCode=1;});

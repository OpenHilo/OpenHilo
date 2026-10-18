const {test}=require('node:test');const assert=require('node:assert/strict');const {parseAiExecutionConfig}=require('../dist/ai-config');
const config=()=>({adapter:'routed',routes:{default:{defaultLevel:'medium',levels:{medium:{adapter:'codex'}}},search:{defaultLevel:'light',levels:{light:{adapter:'sdk',default_profile:'main',profiles:{main:{provider:'openai',model:'search-model',api_key_env:'SEARCH_KEY'}}}}}}});
test('direct routing configuration accepts Codex and SDK with no registry or revision',()=>{const c=config();assert.deepEqual(parseAiExecutionConfig(c),c);c.routes.default.levels.medium.model='later';assert.equal(parseAiExecutionConfig(config()).routes.default.levels.medium.model,undefined)});
test('routing validation rejects bad configurations and never echoes pasted secrets',()=>{
 for(const mutate of [c=>delete c.routes.default,c=>c.routes.default.defaultLevel='max',c=>c.routes.default.levels.medium=[{adapter:'codex'}],c=>c.routes.default.levels.medium={adapter:'routed',routes:{}},c=>c.routes.default.levels.medium={adapter:'claude-code'},c=>c.routes.default.levels.medium.api_key='SECRET',c=>c.routes.default.levels.medium='registered-name',c=>c.routes.typo=c.routes.default,c=>c.routes.default.selected='SECRET',c=>c.revision='SECRET']){
 const c=config();mutate(c);assert.throws(()=>parseAiExecutionConfig(c),e=>!e.message.includes('SECRET'));
 }
});

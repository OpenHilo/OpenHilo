const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseStudioApplication,GENERIC_STUDIO_APPLICATION}=require('../dist');
test('workflow presentation is optional, copied and validates metadata selectors',()=>{
 const input={...GENERIC_STUDIO_APPLICATION,workflowFacet:{field:'stage',label:'Stage',values:[{value:'draft',label:'Draft'}]},workflowFilterTags:['team']};
 const copy=parseStudioApplication(input);copy.workflowFacet.values[0].label='changed';assert.equal(input.workflowFacet.values[0].label,'Draft');
 for(const field of ['__proto__','constructor','a.b','']) assert.throws(()=>parseStudioApplication({...input,workflowFacet:{...input.workflowFacet,field}}));
 assert.throws(()=>parseStudioApplication({...input,workflowFilterTags:[{}]}));
 assert.throws(()=>parseStudioApplication({...input,workflowFacet:{...input.workflowFacet,values:[{value:'x',label:'X'},{value:'x',label:'Other'}]}}));
});

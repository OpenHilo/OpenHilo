const fs=require('node:fs');
const {parseAiExecutionConfig}=require('@openhilo/studio-contracts/ai-config');
const {configureAiRouting}=require('@openhilo/ai-contracts/routing');
const {CodexTaskExecutor}=require('@openhilo/ai-codex');
const {createSdkTaskExecutor}=require('@openhilo/ai-sdk');
function createExecutor(file, env = process.env) {
  const config = parseAiExecutionConfig(JSON.parse(fs.readFileSync(file,'utf8')));
  if (config?.adapter !== 'routed') throw new Error('Expected a routed AI configuration');
  return configureAiRouting(config.routes, c => {
    let executor;
    if (c.adapter === 'codex') executor = new CodexTaskExecutor({ cliPath: c.cli_path, model: c.model,
      effort: c.effort, sandbox: c.sandbox, codexHome: c.codex_home, timeoutMs: c.timeout_ms });
    else {
      const profiles = Object.fromEntries(Object.entries(c.profiles).map(([name,p]) => {
        const apiKey = env[p.api_key_env];
        if (!apiKey?.trim()) throw new Error('Missing SDK credential environment variable for configured route');
        return [name,{provider:p.provider,model:p.model,apiKey,baseURL:p.base_url,maxOutputTokens:p.max_output_tokens}];
      }));
      executor = createSdkTaskExecutor(profiles,c.default_profile,{timeoutMs:c.timeout_ms});
    }
    return {executor,identity:c};
  });
}
module.exports={createExecutor};

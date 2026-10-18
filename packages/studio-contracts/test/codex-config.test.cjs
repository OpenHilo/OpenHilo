const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseAiExecutionConfig} = require('../dist/ai-config');
test('Codex selection roundtrips explicit executable and sandbox without credentials', () => {
    const value = {
        adapter: 'codex',
        cli_path: '/opt/local/codex',
        model: 'configured-model',
        effort: 'low',
        sandbox: 'read-only',
        timeout_ms: 30000,
        codex_home: '/tmp/codex-home'
    };
    assert.deepEqual(parseAiExecutionConfig(value), value);
    assert.deepEqual(parseAiExecutionConfig({adapter: 'codex'}), {adapter: 'codex'});
});
for (const patch of [{cli_path: ''}, {timeout_ms: 0}, {timeout_ms: Infinity}, {sandbox: 'danger-full-access'}, {api_key: 'secret'}, {effort: 'unknown'}]) test('invalid Codex setting fails closed ' + Object.keys(patch)[0], () => {
    assert.throws(() => parseAiExecutionConfig({adapter: 'codex', ...patch}));
});

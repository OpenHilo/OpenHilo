const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createToolHost} = require('../dist');

test('standard formats remain enforced after the Ajv upgrade', async () => {
    let calls = 0;
    const host = createToolHost([{name: 'contact', description: 'validate contact', readOnly: true,
        inputSchema: {type: 'object', properties: {
            email: {type: 'string', format: 'email'}, date: {type: 'string', format: 'date'},
        }, required: ['email', 'date'], additionalProperties: false},
        handler: async args => {calls++; return args;}}]);
    const invoke = args => host.invoke({callId: '1', name: 'contact', arguments: args}, new AbortController().signal);
    for (const args of [{email: 'invalid', date: '2026-10-23'}, {email: 'test@example.com', date: '2026-02-30'}]) {
        const result = await invoke(args);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'invalid_request');
    }
    assert.equal(calls, 0);
    assert.equal((await invoke({email: 'test@example.com', date: '2026-10-23'})).ok, true);
    assert.equal(calls, 1);
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const call = executor => ({
    id: 'node',
    type: 'call',
    executor,
    callee: 'test',
    inputsFrom: {},
    outputsTo: {},
    outputs: {},
    next: 'END'
});
test('runtime requires explicit execution ports and never falls back to an AI or code implementation', async () => {
    const dispatch = createDispatcher({workdir: '/explicit-workspace'});
    for (const kind of ['ai', 'code', 'sys']) await assert.rejects(dispatch(call(kind), {}), new RegExp(`${kind}Executor not configured`));
    assert.deepEqual(await dispatch({
        ...call('sys'),
        callee: 'getWorkdir'
    }, {}), {outputs: {path: '/explicit-workspace'}});
});
test('application context reaches injected system and code executors without interpretation', async () => {
    const context = {extensions: [{namespace: 'example', version: 1, data: {mode: 'custom'}}]};
    const seen = [];
    const executor = async (node, inputs, passed) => {
        seen.push([node.executor, inputs, passed]);
        return {outputs: {}};
    };
    const dispatch = createDispatcher({workdir: '/explicit-workspace', sysExecutor: executor, codeExecutor: executor});
    await dispatch(call('sys'), {value: 3}, context);
    await dispatch(call('code'), {value: 4}, context);
    assert.deepEqual(seen, [['sys', {value: 3}, context], ['code', {value: 4}, context]]);
});


test('AI events reach runtime context even if a supplied observer throws', async () => {
    const {createTaskExecution} = require('@openhilo/ai-contracts');
    const events = [];
    const dispatch = createDispatcher({
        workdir: '/explicit-workspace',
        aiHost: () => ({
            monitoring: {heartbeatMs: 5, slowAfterMs: 5, stalledAfterMs: 10}, onEvent() {
                throw new Error('observer');
            }
        }),
        aiExecutor: {
            id: 'offline', capabilities: ['workspace', 'structured_output'], async start(request, host) {
                return createTaskExecution(request, host, async () => {
                    await new Promise(resolve => setTimeout(resolve, 25));
                    return {status: 'completed', outputs: {}, artifacts: []};
                });
            }
        },
    });
    await dispatch(call('ai'), {}, {extensions: [], onAiEvent: event => events.push(event)});
    assert.ok(events.some(event => event.type === 'health' && event.health.condition === 'stalled'));
    assert.equal(events.at(-1).type, 'terminal');
});

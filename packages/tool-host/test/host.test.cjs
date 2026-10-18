const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createToolHost} = require('../dist');
const schema = {
    type: 'object',
    properties: {value: {type: 'integer'}},
    required: ['value'],
    additionalProperties: false
};
const tool = (handler, extra = {}) => ({name: 'work', description: 'work', inputSchema: schema, handler, ...extra});
const call = (host, args = {value: 1}, signal = new AbortController().signal) => host.invoke({
    callId: 'call-1',
    name: 'work',
    arguments: args
}, signal);

test('validates nested schemas without coercing or executing invalid input', async () => {
    let invoked = 0;
    const host = createToolHost([tool(async args => {
        invoked++;
        return args;
    })]);
    for (const args of [{}, {value: '1'}, {value: 1, surprise: true}, null, [], {value: NaN}]) {
        const result = await call(host, args);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'invalid_request');
        assert.equal(result.error.safeToReplay, true);
    }
    assert.equal(invoked, 0);
    assert.deepEqual(await call(host), {ok: true, output: {value: 1}});
});

test('schema mistakes fail at registration, including unknown keywords and formats', () => {
    for (const inputSchema of [{type: 'object', requird: ['value']}, {
        type: 'object',
        properties: {value: {type: 'string', format: 'misspelled'}}
    }, {type: 'object', $async: true}]) {
        assert.throws(() => createToolHost([tool(async () => null, {inputSchema})]));
    }
    assert.throws(() => createToolHost([tool(async () => null), tool(async () => null)]), /duplicate/);
});

test('validates oneOf and nested required fields', async () => {
    const host = createToolHost([tool(async args => args, {
        inputSchema: {
            type: 'object',
            properties: {
                nested: {
                    oneOf: [{type: 'string'}, {
                        type: 'object',
                        properties: {count: {type: 'integer'}},
                        required: ['count']
                    }]
                }
            },
            required: ['nested']
        }
    })]);
    assert.equal((await call(host, {nested: {}})).ok, false);
    assert.equal((await call(host, {nested: {count: 1}})).ok, true);
});

test('schemas, arguments and outputs cannot be changed through aliases', async () => {
    const definition = tool(async args => {
        args.value = 7;
        return result;
    });
    const result = {value: 2};
    const host = createToolHost([definition]);
    const args = {value: 1};
    definition.inputSchema = {type: 'object'};
    host.definitions[0].inputSchema.required.length = 0;
    assert.equal((await call(host, {})).ok, false);
    const received = await call(host, args);
    result.value = 3;
    assert.deepEqual(received, {ok: true, output: {value: 2}});
    assert.equal(args.value, 1);
});

test('rejects non-JSON output and does not invoke input getters', async () => {
    let invoked = false;
    const host = createToolHost([tool(async () => {
        invoked = true;
        return {bad: undefined};
    })]);
    const args = Object.defineProperty({}, 'value', {
        enumerable: true, get() {
            throw new Error('getter');
        }
    });
    assert.equal((await call(host, args)).error.code, 'invalid_request');
    assert.equal(invoked, false);
    assert.equal((await call(host)).error.code, 'invalid_output');
});

test('pre-cancel does not invoke the handler', async () => {
    const controller = new AbortController();
    controller.abort();
    let count = 0;
    const host = createToolHost([tool(async () => ++count)]);
    assert.equal((await call(host, undefined, controller.signal)).error.safeToReplay, true);
    assert.equal(count, 0);
});

test('abort reaches handler and waits for cleanup; mutation errors are never replayed', async () => {
    const controller = new AbortController();
    let cleanup;
    const host = createToolHost([tool(async (_args, {signal}) => {
        await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
        await new Promise(resolve => {
            cleanup = resolve;
        });
        throw new Error('cancelled after starting');
    })]);
    let settled = false;
    const pending = call(host, undefined, controller.signal).then(result => {
        settled = true;
        return result;
    });
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    cleanup();
    const result = await pending;
    assert.equal(result.error.code, 'outcome_unknown');
    assert.equal(result.error.safeToReplay, false);
});

test('late success is authoritative; no host retry or deduplication is implied', async () => {
    const controller = new AbortController();
    let count = 0;
    const host = createToolHost([tool(async () => {
        count++;
        controller.abort();
        return count;
    })]);
    assert.deepEqual(await call(host, undefined, controller.signal), {ok: true, output: 1});
    assert.deepEqual(await call(host), {ok: true, output: 2});
});

test('unknown tools fail before side effects; read-only handler exceptions are safely replayable', async () => {
    const host = createToolHost([tool(async () => {
        throw new Error('read failed');
    }, {readOnly: true})]);
    assert.equal((await host.invoke({
        callId: '1',
        name: 'unknown',
        arguments: {}
    }, new AbortController().signal)).error.code, 'invalid_request');
    assert.deepEqual((await call(host)).error, {
        code: 'tool_failed',
        message: 'read failed',
        retryable: false,
        safeToReplay: true
    });
});

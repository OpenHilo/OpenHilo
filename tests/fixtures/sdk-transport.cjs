const assert = require('node:assert/strict');

function response(provider, calls, usage = true) {
    if (provider === 'openai') return {
        id: 'resp-fixture', object: 'response', model: 'fixture-model', status: 'completed',
        output: calls.map(c => ({
            type: 'function_call',
            id: `fc_${c.id}`,
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.args),
            status: 'completed'
        })),
        ...(usage ? {
            usage: {
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: 5,
                input_tokens_details: {cached_tokens: 0},
                output_tokens_details: {reasoning_tokens: 0}
            }
        } : {})
    };
    return {
        id: 'msg-fixture',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: calls.map(c => ({type: 'tool_use', id: c.id, name: c.name, input: c.args})),
        ...(usage ? {
            usage: {
                input_tokens: 3,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0
            }
        } : {})
    };
}

function transport(provider, steps) {
    const bodies = [];
    const fetch = async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        const step = steps[bodies.length - 1];
        assert.notEqual(step, undefined, 'Fixture exhausted: unexpected model request');
        const data = typeof step === 'function' ? await step(bodies.at(-1)) : step;
        if (data instanceof Response) return data;
        return new Response(JSON.stringify(Array.isArray(data) ? response(provider, data) : data), {
            status: 200,
            headers: {'content-type': 'application/json'}
        });
    };
    return {fetch, bodies};
}

const call = (name, args, id = name) => ({id, name, args});
module.exports = {response, transport, call};

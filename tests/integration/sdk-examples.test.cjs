const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {response, transport, call} = require('../fixtures/sdk-transport.cjs');
const root = path.resolve(__dirname, '../..');

function helpers() {
    assert.ok(fs.existsSync(path.join(root, 'examples/lib/sdk.cjs')), 'standalone SDK example helper exists');
    return {...require('../../examples/lib/sdk.cjs'), ...require('../../examples/sdk-text/run.cjs'), ...require('../../examples/sdk-tools/run.cjs')};
}

function setup(provider, steps) {
    const h = transport(provider, steps), env = provider === 'openai' ? {
        OPENAI_API_KEY: 'fixture-secret',
        OPENAI_MODEL: 'fixture-model'
    } : {ANTHROPIC_API_KEY: 'fixture-secret', ANTHROPIC_MODEL: 'fixture-model'};
    return {...h, executor: helpers().createExampleExecutor(provider, {env, fetch: h.fetch})};
}

const catalogue = [{id: 'garden', title: 'Garden plan', description: 'Plant herbs and collect rainwater.'}];
for (const provider of ['openai', 'anthropic']) {
    test(`${provider}: official SDK summarizes text without host tools/workspace and releases its session`, async () => {
        const h = setup(provider, [[call('finish_task', {summary: 'A garden collects rainwater.'})]]);
        const result = await helpers().summarizeText({
            executor: h.executor,
            text: 'A community garden grows herbs and collects rainwater.',
            write: () => {
            }
        });
        assert.equal(result.outputs.summary, 'A garden collects rainwater.');
        assert.deepEqual(h.bodies[0].tools.map(t => t.name).sort(), ['ask_user', 'finish_task']);
        await assert.rejects(h.executor.start({
            version: 1,
            taskId: 'later',
            instruction: 'continue',
            inputs: {},
            output: {summary: 'text'},
            requiredCapabilities: [],
            continuation: result.session
        }, {
            attemptId: 'later', signal: new AbortController().signal, onEvent() {
            }
        }), /expired/);
    });
    test(`${provider}: actual read-only catalog lookup receives validated arguments before completion`, async () => {
        const h = setup(provider, [[call('lookup', {id: 'garden'})], body => {
            assert.match(JSON.stringify(body), /Plant herbs and collect rainwater/);
            return [call('finish_task', {summary: 'Plant herbs and reuse rainwater.'}, 'finish')];
        }]);
        const result = await helpers().lookupCatalog({
            executor: h.executor,
            catalog: catalogue,
            id: 'garden',
            write: () => {
            }
        });
        assert.equal(result.outputs.summary, 'Plant herbs and reuse rainwater.');
        assert.equal(h.bodies.length, 2);
        assert.deepEqual(h.bodies[0].tools.map(t => t.name).sort(), ['ask_user', 'finish_task', 'lookup']);
    });
    test(`${provider}: missing output and unexpected questions fail visibly, without a hanging session`, async () => {
        let h = setup(provider, [[call('finish_task', {summary: 7})]]);
        await assert.rejects(helpers().summarizeText({
            executor: h.executor, text: 'text', write: () => {
            }
        }), /invalid_output|expected|output/i);
        h = setup(provider, [[call('ask_user', {prompt: 'Which?', answer: 'text'})]]);
        await assert.rejects(helpers().summarizeText({
            executor: h.executor, text: 'text', write: () => {
            }
        }), /unexpected.*question/i);
        assert.equal(h.bodies.length, 1);
    });
    test(`${provider}: unknown tools and bad parameters do not access catalog; missing entry is explicit`, async () => {
        for (const requested of [call('unregistered', {}), call('lookup', {id: 4}), call('lookup', {
            id: 'garden',
            extra: true
        })]) {
            const h = setup(provider, [[requested], [call('finish_task', {summary: 'not a lookup'}, 'finish')]]);
            await assert.rejects(helpers().lookupCatalog({
                executor: h.executor,
                catalog: catalogue,
                id: 'garden',
                write: () => {
                }
            }), /lookup|Unknown tool|Invalid arguments|invalid_request/);
        }
        const h = setup(provider, [[call('lookup', {id: 'absent'})], body => {
            assert.match(JSON.stringify(body), /found/);
            assert.match(JSON.stringify(body), /false/);
            return [call('finish_task', {summary: 'No item found.'})];
        }]);
        const result = await helpers().lookupCatalog({
            executor: h.executor,
            catalog: catalogue,
            id: 'absent',
            write: () => {
            }
        });
        assert.equal(result.outputs.summary, 'No item found.');
    });
    test(`${provider}: repeated calls and missing finish protocol hit bounded limits`, async () => {
        const repeat = Array.from({length: 5}, (_, i) => [call('lookup', {id: 'garden'}, `lookup-${i}`)]);
        let h = setup(provider, repeat);
        await assert.rejects(helpers().lookupCatalog({
            executor: h.executor,
            catalog: catalogue,
            id: 'garden',
            write: () => {
            }
        }), /limit/);
        assert.ok(h.bodies.length <= 4);
        h = setup(provider, [response(provider, [])]);
        await assert.rejects(helpers().summarizeText({
            executor: h.executor, text: 'text', write: () => {
            }
        }), /finish|protocol|tool|output|executor_failed/i);
    });
    test(`${provider}: authentication/rate failures never log secrets or retry automatically`, async () => {
        for (const status of [401, 429]) {
            const h = setup(provider, [new Response(JSON.stringify({
                error: {
                    message: 'fixture-secret',
                    type: 'authentication_error'
                }
            }), {status, headers: {'content-type': 'application/json'}})]);
            await assert.rejects(helpers().summarizeText({
                executor: h.executor, text: 'text', write: () => {
                }
            }), e => {
                assert.doesNotMatch(e.message, /fixture-secret/);
                assert.match(e.message, status === 401 ? /authentication_failed/ : /rate_limited/);
                return true;
            });
            assert.equal(h.bodies.length, 1);
        }
    });
}
test('SDK CLI configuration is explicit and pure construction has no ambient provider fallback', () => {
    const {createExampleExecutor} = helpers();
    assert.throws(() => createExampleExecutor('openai', {env: {}}), /OPENAI_API_KEY/);
    assert.throws(() => createExampleExecutor('anthropic', {env: {ANTHROPIC_API_KEY: 'not-logged'}}), /ANTHROPIC_MODEL/);
    assert.throws(() => createExampleExecutor('other', {env: {}}), /provider/);
    const r = spawnSync(process.execPath, [path.join(root, 'examples/sdk-text/run.cjs'), '--provider', 'openai', '--input', path.join(root, 'examples/sdk-text/input.txt')], {
        encoding: 'utf8',
        env: {...process.env, OPENAI_API_KEY: '', OPENAI_MODEL: ''},
        timeout: 5000
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OPENAI_API_KEY/);
});

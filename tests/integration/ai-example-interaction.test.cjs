const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const {createAiInteraction} = require('../../examples/lib/resources.cjs');
const request = {
    version: 1,
    taskId: 'question-fixture',
    instruction: 'Answer a small question',
    inputs: {},
    output: {report: 'text'},
    requiredCapabilities: []
};
const completed = report => ({status: 'completed', outputs: {report}, artifacts: []});
test('numbered AI options answer this execution with the option value, independently of Human nodes', async () => {
    let text = '', asked = 0;
    const controller = new AbortController();
    const bridge = createAiInteraction({
        signal: controller.signal, write: s => {
            text += s;
        }, log: s => {
            text += s;
        }, prompts: {
            interactive: true, async ask() {
                asked++;
                return '2';
            }
        }
    });
    const execution = createTaskExecution(request, {
        attemptId: 'choose',
        signal: controller.signal,
        onEvent: bridge.onEvent
    }, async ctx => {
        const answer = await ctx.ask({
            id: 'temporary-1',
            prompt: 'Which tone?',
            answer: 'text',
            optionsMode: 'exclusive',
            options: [{label: 'Formal', value: 'formal'}, {label: 'Friendly', value: 'friendly', recommended: true}]
        });
        return completed(answer);
    });
    bridge.attach(execution, request);
    const result = await execution.result;
    await bridge.close();
    assert.equal(result.status, 'completed');
    assert.equal(result.outputs.report, 'friendly');
    assert.equal(asked, 1);
    assert.match(text, /2\. Friendly \(recommended\)/);
    assert.match(text, /not a saved Human node/);
});
test('noninteractive AI question cancels and reports stopping until real cleanup finishes', async () => {
    let text = '', release, notify;
    const cleanup = new Promise(r => {
        release = r;
    });
    const stopping = new Promise(r => {
        notify = r;
    });
    const controller = new AbortController();
    const bridge = createAiInteraction({
        signal: controller.signal, write: s => {
            text += s;
        }, log: s => {
            text += s;
        }, prompts: {
            interactive: false, ask() {
                throw Error('must not prompt');
            }
        }
    });
    const execution = createTaskExecution(request, {
        attemptId: 'unattended',
        signal: controller.signal,
        monitoring: {heartbeatMs: 10, slowAfterMs: 20, stalledAfterMs: 40, stopGraceMs: 1000},
        onEvent(e) {
            bridge.onEvent(e);
            if (e.type === 'health' && e.health.phase === 'stopping') notify();
        }
    }, async ctx => {
        try {
            await ctx.ask({id: 'unattended-question', prompt: 'Need input', answer: 'text'});
            return completed('must not happen');
        } finally {
            await cleanup;
        }
    });
    bridge.attach(execution, request);
    await stopping;
    try {
        assert.equal(execution.state, 'stopping');
        assert.doesNotMatch(text, /AI cancelled;/);
        assert.match(text, /no interactive terminal/);
    } finally {
        release();
    }
    const result = await execution.result;
    await bridge.close();
    assert.equal(result.status, 'cancelled');
    assert.match(text, /AI cancelled;/);
});
test('suggested answers allow text, while invalid JSON is reprompted', async () => {
    const answers = ['not json', '{"ok":true}'];
    let prompts = 0, text = '';
    const controller = new AbortController();
    const bridge = createAiInteraction({
        signal: controller.signal, write: s => {
            text += s;
        }, log: s => {
            text += s;
        }, prompts: {
            interactive: true, async ask() {
                prompts++;
                return answers.shift();
            }
        }
    });
    const execution = createTaskExecution(request, {
        attemptId: 'json',
        signal: controller.signal,
        onEvent: bridge.onEvent
    }, async ctx => {
        const answer = await ctx.ask({id: 'json-question', prompt: 'Return JSON', answer: 'json'});
        return completed(JSON.stringify(answer));
    });
    bridge.attach(execution, request);
    const result = await execution.result;
    await bridge.close();
    assert.equal(result.outputs.report, '{"ok":true}');
    assert.equal(prompts, 2);
    assert.match(text, /valid JSON/);
});

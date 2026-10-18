const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTerminalOutput, createRunConsole} = require('../../examples/lib/console.cjs');
const {createAiInteraction} = require('../../examples/lib/resources.cjs');

test('terminal logs are dim, information uses default contrast, prompts are emphasized and styles reset', () => {
    const chunks = [];
    const out = createTerminalOutput(text => chunks.push(text), {isTTY: true, env: {TERM: 'xterm-256color'}});
    out.log('AI running\n');
    out.info('Please reply\n');
    out.prompt('answer: ');
    assert.equal(chunks[0], '\x1b[2m[log] AI running\x1b[22m\n');
    assert.equal(chunks[1], 'Please reply\n');
    assert.equal(chunks[2], '\x1b[1manswer: \x1b[22m');
});
for (const options of [{isTTY: false, env: {}}, {isTTY: true, env: {NO_COLOR: ''}}, {
    isTTY: true,
    env: {TERM: 'dumb'}
}]) test('plain terminal output remains identifiable without ANSI ' + JSON.stringify(options), () => {
    let text = '';
    const out = createTerminalOutput(s => text += s, options);
    out.log('AI running\n');
    out.info('Please reply\n');
    out.prompt('answer: ');
    assert.equal(text, '[log] AI running\nPlease reply\nanswer: ');
});
test('workflow progress is log output but errors and human requests remain clear', () => {
    let text = '';
    const display = createRunConsole(s => text += s);
    display.onEvent({event: 'run_start', run_id: 'r'});
    display.onEvent({event: 'node_suspended'});
    display.onEvent({event: 'node_failed', error: 'Visible failure'});
    assert.match(text, /\[log\] Run r/);
    assert.match(text, /Waiting for human/);
    assert.doesNotMatch(text, /\[log\] Waiting for human|\[log\] Notice/);
});
test('AI health and usage are logs, clarification and validation are user information', async () => {
    let info = '', logs = '';
    const bridge = createAiInteraction({
        write: s => info += s,
        log: s => logs += s,
        signal: new AbortController().signal,
        prompts: {
            interactive: true, async ask() {
                return 'yes';
            }
        }
    });
    bridge.onEvent({type: 'health', health: {phase: 'running', condition: 'active', elapsedMs: 1, idleMs: 0}});
    bridge.onEvent({type: 'question', question: {id: 'q', prompt: 'Reply now', answer: 'text'}});
    bridge.attach({
        result: Promise.resolve({status: 'completed', outputs: {}, usage: null}), async answer() {
            return 'accepted';
        }
    }, {});
    await bridge.close();
    assert.match(logs, /AI running|AI completed/);
    assert.doesNotMatch(info, /AI running|AI completed/);
    assert.match(info, /Reply now/);
});

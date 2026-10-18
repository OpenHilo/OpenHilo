// Example presentation only: never put ANSI styling into saved execution events.
function createTerminalOutput(write = text => process.stdout.write(text), {
    isTTY = !!process.stdout.isTTY,
    env = process.env
} = {}) {
    const styled = isTTY && !Object.hasOwn(env, 'NO_COLOR') && env.TERM !== 'dumb';
    const emit = (text, code) => {
        const newline = text.endsWith('\n') ? '\n' : '';
        const body = newline ? text.slice(0, -1) : text;
        write(styled && code ? `\x1b[${code}m${body}\x1b[22m${newline}` : text);
    };
    return {
        log: text => emit(`[log] ${text}`, 2),
        info: text => emit(text),
        prompt: text => emit(text, 1),
    };
}

// Keep console feedback separate from engine state. History remains authoritative.
function createRunConsole(write = text => process.stdout.write(text), {suspendedMessage = 'No answer was submitted; the run is paused. No report was saved.'} = {}) {
    const {log, info} = createTerminalOutput(write);
    let outputs, lastProblem;
    return {
        onEvent(event) {
            if (event.event === 'run_start' || event.event === 'run_resume') log(`Run ${event.run_id}: ${event.event === 'run_resume' ? 'resuming saved snapshot' : 'started'}\n`);
            if (event.event === 'node_pending' && event.executor && event.executor !== 'human') log(`Running ${event.executor}: ${event.intent_name} / ${event.node_id}\n`);
            if (event.event === 'node_suspended') info('Waiting for human: review the displayed values, then submit a result. Ctrl+C pauses.\n');
            if (event.event === 'run_complete') outputs = event.outputs;
            if (['node_failed', 'human_delivery_failed', 'run_abort', 'run_failed'].includes(event.event)) {
                lastProblem = event.error ?? event.reason;
                info(`Notice: ${lastProblem}\n`);
            }
        },
        get outputs() {
            return outputs;
        },
        finish(run) {
            log(`Run ${run.status}. Records: ${run.runDir}\n`);
            if (run.status === 'suspended') info(`${suspendedMessage}\n`);
            if (lastProblem) info(`Last issue: ${lastProblem}\n`);
        },
    };
}

function createTerminalHuman(options = {}) {
    const {TerminalHumanExecutor} = require('@openhilo/human-terminal');
    return new TerminalHumanExecutor({write: createTerminalOutput().info, ...options});
}

module.exports = {createRunConsole, createTerminalHuman, createTerminalOutput};

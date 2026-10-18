// Example host composition, not a plugin loader. Providers remain explicit.
const fs = require('node:fs');
const path = require('node:path');
const {createInterface} = require('node:readline');
const {spawnSync} = require('node:child_process');
const {createTaskExecution} = require('@openhilo/ai-contracts');
const {CodexTaskExecutor} = require('@openhilo/ai-codex');
const {createDispatcher} = require('@openhilo/runtime/dispatcher');
const {createCodeExecutor} = require('@openhilo/code-local');
const {createTerminalOutput} = require('./console.cjs');
const {TerminalHumanExecutor} = require('@openhilo/human-terminal');

function validateProvider(provider) {
    if (!['codex', 'offline'].includes(provider)) throw new Error('Choose --provider codex or --provider offline explicitly. Offline uses a scripted example, not a model.');
}

function checkProvider(provider) {
    validateProvider(provider);
    if (provider === 'offline') return null;
    const result = spawnSync('codex', ['--version'], {encoding: 'utf8', timeout: 5000});
    if (result.error || result.status !== 0) throw new Error('Codex CLI is unavailable. Install Codex CLI and sign in, or explicitly choose --provider offline.');
    const version = result.stdout.trim();
    return version;
}

function promptSession(onInterrupt) {
    const output = createTerminalOutput();
    const readline = createInterface({input: process.stdin, output: process.stdout});
    const lines = readline[Symbol.asyncIterator]();
    readline.on('SIGINT', onInterrupt);
    return {
        interactive: !!process.stdin.isTTY,
        async ask(text, signal) {
            signal?.throwIfAborted();
            output.prompt(text);
            let abort;
            const stopped = new Promise((_, reject) => {
                abort = () => reject(signal.reason);
                signal?.addEventListener('abort', abort, {once: true});
            });
            try {
                const line = await Promise.race([lines.next(), stopped]);
                if (line.done) throw new Error('Terminal input closed (EOF) before submission');
                return line.value;
            } finally {
                signal?.removeEventListener('abort', abort);
            }
        },
        close() {
            readline.off('SIGINT', onInterrupt);
            readline.close();
        },
    };
}

// A host event bridge also usable by direct task examples. Question IDs never
// become Human task IDs; temporary AI questions are answered on this execution.
function createAiInteraction({
                                 prompts,
                                 signal,
                                 write = createTerminalOutput().info,
                                 log = createTerminalOutput().log,
                                 onResult = () => {
                                 }
                             }) {
    let execution, queue = Promise.resolve(), lastHealth = '', lastPrinted = 0;
    const pending = [];

    function handle(question) {
        queue = queue.then(async () => {
            if (!prompts.interactive) throw new Error('AI asked a temporary question but no interactive terminal is available; cancelling this attempt.');
            write(`AI clarification (not a saved Human node): ${question.prompt}\n`);
            for (const [i, option] of (question.options ?? []).entries()) write(`${i + 1}. ${option.label}${option.recommended ? ' (recommended)' : ''}${option.reason ? ': ' + option.reason : ''}\n`);
            for (; ;) {
                const raw = await prompts.ask(question.options?.length ? 'Choose a number or type an answer: ' : 'Answer: ', signal);
                const index = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) - 1 : -1;
                const option = question.options?.[index];
                if (!option && question.optionsMode === 'exclusive') {
                    write('Choose one of the listed numbers.\n');
                    continue;
                }
                let value = option ? option.value : raw;
                if (question.answer === 'json' && !option) {
                    try {
                        value = JSON.parse(raw);
                    } catch {
                        write('Enter valid JSON.\n');
                        continue;
                    }
                }
                const receipt = await execution.answer(question.id, value);
                if (receipt === 'accepted' || receipt === 'duplicate') break;
                if (receipt === 'invalid_answer') {
                    write('The answer did not match this question. Try again.\n');
                    continue;
                }
                throw new Error(`AI question no longer accepts an answer (${receipt})`);
            }
        }).catch(async error => {
            write(`${error.message}\nStopping AI; waiting for execution cleanup.\n`);
            await execution?.cancel(error.message);
        });
        void queue.catch(error => write(`AI cancellation delivery failed: ${error.message}\n`));
    }

    return {
        onEvent(event) {
            if (event.type === 'health') {
                const health = event.health, key = `${health.phase}/${health.condition}`;
                if (key !== lastHealth || health.elapsedMs - lastPrinted >= 10000) {
                    log(`AI ${health.phase} · ${health.condition} · ${Math.floor(health.elapsedMs / 1000)}s elapsed, ${Math.floor(health.idleMs / 1000)}s without progress${health.phase === 'stopping' ? ' · cleanup is not yet finished' : ''}\n`);
                    lastHealth = key;
                    lastPrinted = health.elapsedMs;
                }
            }
            if (event.type === 'question') {
                if (execution) handle(event.question); else pending.push(event.question);
            }
        },
        attach(active, request) {
            execution = active;
            lastHealth = '';
            lastPrinted = 0;
            for (const question of pending.splice(0)) handle(question);
            void active.result.then(result => {
                onResult(request, result);
                log(`AI ${result.status}; usage: ${result.usage ? JSON.stringify(result.usage) : 'not reported'}\n`);
            }).catch(error => write(`AI result observer failed: ${error.message}\n`));
        },
        async close() {
            await queue;
        },
    };
}

function createResources(context, {provider, deferHuman = false, aiExecutor: suppliedExecutor}) {
    validateProvider(provider);
    const output = createTerminalOutput();
    const controller = new AbortController();
    const interrupt = () => {
        if (!controller.signal.aborted) {
            output.info('Stopping requested; waiting for the current operation to settle.\n');
            controller.abort(new DOMException('Terminal interrupted (SIGINT)', 'AbortError'));
        }
    };
    const prompts = promptSession(interrupt);
    process.on('SIGINT', interrupt);
    const interaction = createAiInteraction({
        prompts, signal: controller.signal, onResult(request, result) {
            fs.appendFileSync(path.join(context.runDir, 'ai-attempts.jsonl'), JSON.stringify({
                taskId: request.taskId,
                provider,
                inputs: request.inputs,
                status: result.status,
                outputs: result.status === 'completed' ? result.outputs : null,
                usage: result.usage ?? null
            }) + '\n');
        }
    });
    const aiExecutor = suppliedExecutor ?? (provider === 'codex'
        ? new CodexTaskExecutor({sandbox: 'read-only', effort: 'low', timeoutMs: 120000})
        : {
            id: 'openhilo.example.scripted', capabilities: ['structured_output', 'workspace'], start(request, host) {
                return Promise.resolve(createTaskExecution(request, host, async () => ({
                    status: 'completed', outputs: {
                        report: `[OFFLINE scripted draft ${request.inputs.round}] ${request.inputs.topic}\n${request.inputs.notes}\nFeedback: ${request.inputs.feedback || '(none)'}`,
                    }, artifacts: []
                })));
            }
        });
    const terminal = new TerminalHumanExecutor({
        write: output.info,
        promptFn: (text, signal) => prompts.ask(text, AbortSignal.any([signal, controller.signal].filter(Boolean)))
    });
    return {
        humanExecutor: {
            id: deferHuman ? 'example.deferred' : terminal.id, async present(request, host) {
                if (deferHuman) {
                    output.info('Human review deferred. This process will exit with a saved pending request.\n');
                    return;
                }
                return terminal.present(request, host);
            }
        },
        executor: createDispatcher({
            runId: context.runId,
            workdir: context.workdir,
            codeExecutor: createCodeExecutor(context.workdir),
            aiExecutor,
            aiHost: () => ({
                signal: controller.signal,
                monitoring: {heartbeatMs: 2000, slowAfterMs: 15000, stalledAfterMs: 45000, stopGraceMs: 3000},
                onEvent: interaction.onEvent
            }),
            onAiExecution: interaction.attach,
        }),
        async close() {
            controller.abort(new DOMException('Example resources closing', 'AbortError'));
            prompts.close();
            process.off('SIGINT', interrupt);
            await interaction.close();
        },
    };
}

module.exports = {createResources, createAiInteraction, validateProvider, checkProvider};

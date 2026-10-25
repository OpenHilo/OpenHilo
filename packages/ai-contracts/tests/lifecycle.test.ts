import {
    type AiExecution,
    ContractError,
    createTaskExecution,
    type ExecutionHost,
    type Failure,
    type JsonValue,
    type TaskEvent,
    type TaskRequest
} from '../src';
import {ScriptedExecutor, type Step} from './support/scripted-executor';

const question: Step = {
    type: 'question',
    question: {
        id: 'q1',
        prompt: 'Choose',
        answer: 'text',
        optionsMode: 'exclusive',
        options: [{label: 'Yes', value: 'yes'}]
    }
};
const complete: Step = {type: 'complete', outputs: {summary: 'done', ignored: 1}};

function input() {
    const events: TaskEvent[] = [];
    const controller = new AbortController();
    const request: TaskRequest = {
        version: 1,
        taskId: 'task',
        instruction: 'Test',
        inputs: {},
        output: {summary: 'text'},
        requiredCapabilities: []
    };
    const host: ExecutionHost = {
        attemptId: 'attempt', signal: controller.signal, onEvent: event => {
            events.push(event);
        }
    };
    return {events, controller, request, host};
}

test('events are ordered per attempt, terminal once, and result is authoritative', async () => {
    const x = input();
    const execution = await new ScriptedExecutor([{
        type: 'progress',
        message: 'working'
    }, complete]).start(x.request, x.host);
    expect(await execution.result).toEqual({status: 'completed', outputs: {summary: 'done'}, artifacts: []});
    expect(execution.state).toBe('completed');
    expect(x.events.map(event => event.type)).toEqual(['started', 'progress', 'terminal']);
    expect(x.events.map(event => event.sequence)).toEqual([1, 2, 3]);
    for (const event of x.events) {
        expect(event.taskId).toBe('task');
        expect(event.attemptId).toBe('attempt');
        expect(Number.isFinite(Date.parse(event.timestamp))).toBe(true);
    }
    const terminal = x.events.at(-1);
    expect(terminal?.type === 'terminal' && terminal.result).toEqual(await execution.result);
    await execution.cancel('too late');
    expect(execution.state).toBe('completed');
    expect(x.events.filter(event => event.type === 'terminal')).toHaveLength(1);
});

test('serial questions validate answers and accepted ids cannot be replaced', async () => {
    const x = input();
    const execution = await new ScriptedExecutor([question, {
        type: 'question',
        question: {id: 'q2', prompt: 'JSON?', answer: 'json'}
    }, complete]).start(x.request, x.host);
    expect(execution.state).toBe('waiting_for_input');
    expect(await execution.answer('missing', 'yes')).toBe('unknown_question');
    expect(await execution.answer('q1', 1)).toBe('invalid_answer');
    expect(await execution.answer('q1', 'no')).toBe('invalid_answer');
    expect(await execution.answer('q1', 'yes')).toBe('accepted');
    expect(await execution.answer('q1', 'replacement')).toBe('duplicate');
    expect(execution.state).toBe('waiting_for_input');
    expect(await execution.answer('q2', {bad: undefined} as unknown as JsonValue)).toBe('invalid_answer');
    expect(await execution.answer('q2', {ok: [true, null]})).toBe('accepted');
    expect((await execution.result).status).toBe('completed');
    expect(await execution.answer('q2', false)).toBe('duplicate');
    expect(await execution.answer('missing', null)).toBe('closed');
    expect(x.events.map(event => event.type)).toEqual(['started', 'question', 'answered', 'question', 'answered', 'terminal']);
});

test.each(['a free-form answer', 'yes; with additional context'])('suggested options accept text outside listed values: %s', async value => {
    const x = input();
    const execution = await new ScriptedExecutor([
        {
            type: 'question',
            question: {id: 'q', prompt: 'Choose or write', answer: 'text', options: [{label: 'Yes', value: 'yes'}]}
        },
        complete,
    ]).start(x.request, x.host);
    expect(await execution.answer('q', value)).toBe('accepted');
    expect((await execution.result).status).toBe('completed');
});

test.each(['manual', 'signal'] as const)('%s cancellation while waiting settles once and closes unanswered questions', async mode => {
    const x = input();
    const execution = await new ScriptedExecutor([question, complete]).start(x.request, x.host);
    if (mode === 'manual') await execution.cancel('stop'); else x.controller.abort('stop');
    await execution.cancel('again');
    expect(await execution.result).toEqual({status: 'cancelled', reason: 'stop'});
    expect(await execution.answer('q1', 'yes')).toBe('closed');
    expect(x.events.map(event => event.type)).toEqual(['started', 'question', 'terminal']);
});

test('pre-aborted hosts settle without running script steps', async () => {
    const x = input();
    x.controller.abort('already stopped');
    const execution = await new ScriptedExecutor([{
        type: 'progress',
        message: 'must not run'
    }, complete]).start(x.request, x.host);
    expect(await execution.result).toEqual({status: 'cancelled', reason: 'already stopped'});
    expect(x.events.map(event => event.type)).toEqual(['terminal']);
});

test('expired deadlines settle without running script steps', async () => {
    const x = input();
    x.host.deadlineAt = '2000-01-01T00:00:00.000Z';
    const execution = await new ScriptedExecutor([complete]).start(x.request, x.host);
    expect(await execution.result).toMatchObject({status: 'failed', error: {code: 'timeout', safeToReplay: false}});
    expect(x.events.map(event => event.type)).toEqual(['terminal']);
});

test('deadline pauses while waiting and timers/listeners are cleaned after answering', async () => {
    jest.useFakeTimers({doNotFake: ['queueMicrotask']});
    try {
        const x = input();
        const remove = jest.spyOn(x.controller.signal, 'removeEventListener');
        x.host.deadlineAt = new Date(Date.now() + 100).toISOString();
        const execution = await new ScriptedExecutor([question, complete]).start(x.request, x.host);
        expect(execution.state).toBe('waiting_for_input');
        jest.advanceTimersByTime(100);
        expect(execution.state).toBe('waiting_for_input');
        expect(await execution.answer('q1', 'yes')).toBe('accepted');
        expect(await execution.result).toMatchObject({status: 'completed'});
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(jest.getTimerCount()).toBe(0);
        x.controller.abort('later');
        expect(x.events.filter(event => event.type === 'terminal')).toHaveLength(1);
    } finally {
        jest.useRealTimers();
    }
});

test.each(['complete', 'cancel'] as const)('%s clears future deadline timer and listener', async mode => {
    jest.useFakeTimers({doNotFake: ['queueMicrotask']});
    try {
        const x = input();
        const remove = jest.spyOn(x.controller.signal, 'removeEventListener');
        x.host.deadlineAt = new Date(Date.now() + 100).toISOString();
        const execution = await new ScriptedExecutor(mode === 'complete' ? [complete] : [question, complete]).start(x.request, x.host);
        if (mode === 'cancel') await execution.cancel('stop');
        await execution.result;
        expect(jest.getTimerCount()).toBe(0);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
        jest.useRealTimers();
    }
});

test('far-future active deadlines do not overflow the native timer', async () => {
    jest.useFakeTimers({doNotFake: ['queueMicrotask']});
    try {
        const x = input();
        x.host.deadlineAt = new Date(Date.now() + 3_000_000_000).toISOString();
        x.host.monitoring = {heartbeatMs: 2_000_000_000};
        const execution = createTaskExecution(x.request, x.host, async ctx => {
            await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), {once: true}));
            return {status: 'cancelled', reason: 'stopped'};
        });
        await new Promise<void>(resolve => queueMicrotask(resolve));
        await jest.advanceTimersByTimeAsync(2_147_483_647);
        expect(execution.state).toBe('running');
        await jest.advanceTimersByTimeAsync(3_000_000_000 - 2_147_483_647);
        expect(await execution.result).toMatchObject({status: 'failed', error: {code: 'timeout'}});
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});

test('malformed output fails without implying safe replay', async () => {
    const x = input();
    const execution = await new ScriptedExecutor([{type: 'complete', outputs: {summary: 42}}]).start(x.request, x.host);
    expect(await execution.result).toMatchObject({
        status: 'failed',
        error: {code: 'invalid_output', safeToReplay: false}
    });
});

test('explicit failures preserve retryability, replay safety and details independently', async () => {
    const x = input();
    const error: Failure = {
        code: 'outcome_unknown',
        message: 'Result lost',
        retryable: true,
        safeToReplay: false,
        retryAfterMs: 20,
        details: {attempt: 'a'}
    };
    const execution = await new ScriptedExecutor([{type: 'fail', error}]).start(x.request, x.host);
    expect(await execution.result).toEqual({status: 'failed', error});
});

test.each(['workspace', 'tools', 'hard_budget', 'continue', 'usage'] as const)('unsupported %s rejects before events', async capability => {
    const x = input();
    x.request.requiredCapabilities = [capability];
    await expect(new ScriptedExecutor([complete]).start(x.request, x.host)).rejects.toBeInstanceOf(ContractError);
    expect(x.events).toEqual([]);
});

test('script exhaustion and duplicate question ids are implementation failures', async () => {
    const x = input();
    const empty = await new ScriptedExecutor([]).start(x.request, x.host);
    expect(await empty.result).toMatchObject({status: 'failed', error: {code: 'executor_failed'}});
    const duplicate = await new ScriptedExecutor([question, question, complete]).start(x.request, x.host);
    expect(await duplicate.answer('q1', 'yes')).toBe('accepted');
    expect(await duplicate.result).toMatchObject({status: 'failed', error: {code: 'executor_failed'}});
});

test('observer exceptions cannot change authoritative results', async () => {
    const x = input();
    x.host.onEvent = () => {
        throw new Error('UI unavailable');
    };
    const execution = await new ScriptedExecutor([question, complete]).start(x.request, x.host);
    expect(await execution.answer('q1', 'yes')).toBe('accepted');
    expect((await execution.result).status).toBe('completed');
});

test.each([false, true])('question observer mutation is isolated (throws: %s)', async throws => {
    const x = input();
    x.host.onEvent = event => {
        x.events.push(event);
        if (event.type === 'question') {
            event.question.options![0].value = 'no';
            if (throws) throw new Error('Observer failed after mutation');
        }
    };
    const execution = await new ScriptedExecutor([
        {
            type: 'question',
            question: {
                id: 'isolated',
                prompt: 'Choose',
                answer: 'text',
                optionsMode: 'exclusive',
                options: [{label: 'Yes', value: 'yes'}]
            }
        },
        complete,
    ]).start(x.request, x.host);
    expect(await execution.answer('isolated', 'no')).toBe('invalid_answer');
    expect(await execution.answer('isolated', 'yes')).toBe('accepted');
    expect((await execution.result).status).toBe('completed');
    expect(x.events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(x.events.filter(event => event.type === 'terminal')).toHaveLength(1);
});

test.each([false, true])('completed result observer mutation is isolated (throws: %s)', async throws => {
    const x = input();
    x.host.onEvent = event => {
        x.events.push(event);
        if (event.type === 'terminal' && event.result.status === 'completed') {
            event.result.outputs.summary = 42;
            event.result.artifacts.push({uri: 'observer://injected', kind: 'file', origin: 'observer'});
            if (throws) throw new Error('Observer failed after mutation');
        }
    };
    const execution = await new ScriptedExecutor([complete]).start(x.request, x.host);
    expect(await execution.result).toEqual({status: 'completed', outputs: {summary: 'done'}, artifacts: []});
    expect(x.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(x.events.filter(event => event.type === 'terminal')).toHaveLength(1);
});

test.each([false, true])('failed result observer mutation is isolated (throws: %s)', async throws => {
    const x = input();
    x.host.onEvent = event => {
        x.events.push(event);
        if (event.type === 'terminal' && event.result.status === 'failed') {
            event.result.error.safeToReplay = true;
            (event.result.error.details!.nested as { attempt: string }).attempt = 'observer';
            if (throws) throw new Error('Observer failed after mutation');
        }
    };
    const error: Failure = {
        code: 'outcome_unknown',
        message: 'Result lost',
        retryable: true,
        safeToReplay: false,
        details: {nested: {attempt: 'original'}}
    };
    const execution = await new ScriptedExecutor([{type: 'fail', error}]).start(x.request, x.host);
    expect(await execution.result).toEqual({
        status: 'failed',
        error: {
            code: 'outcome_unknown',
            message: 'Result lost',
            retryable: true,
            safeToReplay: false,
            details: {nested: {attempt: 'original'}}
        }
    });
    expect(x.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(x.events.filter(event => event.type === 'terminal')).toHaveLength(1);
});

test.each(['started', 'progress', 'question', 'answered'] as const)('reentrant abort on %s cannot emit late work', async trigger => {
    const x = input();
    x.host.onEvent = event => {
        x.events.push(event);
        if (event.type === trigger) x.controller.abort('observer cancelled');
    };
    const execution = await new ScriptedExecutor([{
        type: 'progress',
        message: 'working'
    }, question, complete]).start(x.request, x.host);
    if (trigger === 'answered') await execution.answer('q1', 'yes');
    expect(await execution.result).toEqual({status: 'cancelled', reason: 'observer cancelled'});
    expect(x.events.at(-1)?.type).toBe('terminal');
    expect(x.events.filter(event => event.type === 'terminal')).toHaveLength(1);
});

test('reentrant answers do not advance twice or skip a serial question', async () => {
    const x = input();
    let execution: AiExecution | undefined;
    const receipts: Promise<unknown>[] = [];
    x.host.onEvent = event => {
        x.events.push(event);
        if (event.type === 'question' && execution) receipts.push(execution.answer(event.question.id, 'yes'));
    };
    execution = await new ScriptedExecutor([question, {
        type: 'question',
        question: {id: 'q2', prompt: 'Again?', answer: 'text'}
    }, complete]).start(x.request, x.host);
    expect(await execution.answer('q1', 'yes')).toBe('accepted');
    expect((await execution.result).status).toBe('completed');
    expect(await Promise.all(receipts)).toEqual(['accepted']);
    expect(x.events.map(event => event.type)).toEqual(['started', 'question', 'answered', 'question', 'answered', 'terminal']);
});

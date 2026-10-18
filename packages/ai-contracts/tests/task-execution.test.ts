import {createTaskExecution, type ExecutionHost, type TaskEvent, type TaskRequest} from '../src';

const request: TaskRequest = {
    version: 1,
    taskId: 'task',
    instruction: 'work',
    inputs: {},
    output: {answer: 'text'},
    requiredCapabilities: []
};

function setup(overrides: Partial<ExecutionHost> = {}) {
    const events: TaskEvent[] = [];
    const abort = new AbortController();
    const host: ExecutionHost = {
        attemptId: 'attempt',
        signal: abort.signal,
        onEvent: event => events.push(event), ...overrides
    };
    return {host, events, abort};
}

const done = (answer = 'ok') => ({status: 'completed' as const, outputs: {answer}, artifacts: []});

it('validates outputs and emits one terminal event even if the observer throws', async () => {
    const {host} = setup({
        onEvent: () => {
            throw new Error('observer');
        }
    });
    const execution = createTaskExecution(request, host, async () => ({...done(), outputs: {answer: 42}}));
    expect(await execution.result).toMatchObject({status: 'failed', error: {code: 'invalid_output'}});
});

it('protects results and pending question options against event mutation', async () => {
    const {host, events} = setup();
    host.onEvent = event => {
        events.push(event);
        if (event.type === 'question') event.question.options![0].value = 'corrupt';
        if (event.type === 'terminal' && event.result.status === 'completed') event.result.outputs.answer = 'corrupt';
    };
    const execution = createTaskExecution(request, host, async context => {
        const value = await context.ask({
            id: 'q',
            prompt: 'Pick',
            answer: 'text',
            optionsMode: 'exclusive',
            options: [{label: 'OK', value: 'ok'}]
        });
        return done(value as string);
    });
    await Promise.resolve();
    expect(execution.state).toBe('waiting_for_input');
    expect(await execution.answer('q', 'corrupt')).toBe('invalid_answer');
    expect(await execution.answer('q', 'ok')).toBe('accepted');
    expect(await execution.result).toEqual(done());
    expect(await execution.answer('q', 'ok')).toBe('duplicate');
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
});

it('waits for underlying cancellation cleanup before settling', async () => {
    const {host, abort, events} = setup();
    let cleanup!: () => void;
    const execution = createTaskExecution(request, host, async context => {
        await new Promise<void>(resolve => {
            context.signal.addEventListener('abort', () => {
                cleanup = resolve;
            }, {once: true});
        });
        return done();
    });
    await Promise.resolve();
    abort.abort('stop');
    expect(execution.state).toBe('stopping');
    expect(events.filter(event => event.type === 'terminal')).toHaveLength(0);
    cleanup();
    expect(await execution.result).toEqual({status: 'cancelled', reason: 'stop'});
    await execution.cancel('again');
    expect(events.filter(event => event.type === 'terminal')).toHaveLength(1);
});

it('aborts waiting questions and closes their answers', async () => {
    const {host} = setup();
    const execution = createTaskExecution(request, host, async context => {
        await context.ask({id: 'q', prompt: 'Why?', answer: 'text'});
        return done();
    });
    await Promise.resolve();
    await execution.cancel('cancelled by user');
    expect(await execution.result).toMatchObject({status: 'cancelled'});
    expect(await execution.answer('q', 'later')).toBe('closed');
});

it('does not enter the operation for an expired deadline or pre-aborted host', async () => {
    const operation = jest.fn(async () => done());
    const {host, abort} = setup({deadlineAt: '2000-01-01T00:00:00Z'});
    expect(await createTaskExecution(request, host, operation).result).toMatchObject({
        status: 'failed',
        error: {code: 'timeout'}
    });
    abort.abort();
    expect(await createTaskExecution(request, host, operation).result).toMatchObject({status: 'cancelled'});
    expect(operation).not.toHaveBeenCalled();
});

it('expires a live question and clears deadline timers after repeated answers', async () => {
    jest.useFakeTimers();
    try {
        const {host} = setup({deadlineAt: new Date(Date.now() + 1000).toISOString()});
        const execution = createTaskExecution(request, host, async context => {
            await context.ask({id: 'q', prompt: 'Why?', answer: 'text'});
            return done();
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(execution.health?.deadlineAt).toBe(host.deadlineAt);
        await execution.answer('unknown', 'ignored');
        await execution.answer('unknown2', 'ignored');
        await jest.advanceTimersByTimeAsync(1000);
        expect(await execution.result).toMatchObject({
            status: 'failed', error: {
                code: 'timeout',
                message: expect.stringContaining('while waiting for your answer'), safeToReplay: false
            }
        });
        expect(await execution.answer('q', 'late')).toBe('closed');
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});

it('settles with an explicit failure if an implementation returns non-serializable data', async () => {
    const {host, events} = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const execution = createTaskExecution(request, host, async () => ({...done(), artifacts: circular as never}));
    expect(await execution.result).toMatchObject({status: 'failed', error: {code: 'executor_failed'}});
    expect(events.filter(event => event.type === 'terminal')).toHaveLength(1);
});


it('reports a stalled model and stopping timeout without pretending cleanup finished', async () => {
    jest.useFakeTimers();
    try {
        const {host, events} = setup({
            monitoring: {
                heartbeatMs: 10,
                slowAfterMs: 20,
                stalledAfterMs: 40,
                stopGraceMs: 20
            }
        } as Partial<ExecutionHost>);
        let finish!: () => void;
        const execution = createTaskExecution(request, host, async () => {
            await new Promise<void>(resolve => {
                finish = resolve;
            });
            return done();
        });
        await jest.advanceTimersByTimeAsync(20);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
            type: 'health',
            health: expect.objectContaining({condition: 'slow', idleMs: 20})
        })]));
        await jest.advanceTimersByTimeAsync(20);
        expect((execution as any).health).toMatchObject({condition: 'stalled', elapsedMs: 40});
        let settled = false;
        const cancellation = execution.cancel('test stop').then(() => {
            settled = true;
        });
        expect(execution.state).toBe('stopping');
        expect(events.at(-1)).toMatchObject({type: 'health', health: {phase: 'stopping', stopReason: 'cancelled'}});
        await jest.advanceTimersByTimeAsync(30);
        expect((execution as any).health).toMatchObject({phase: 'stopping', condition: 'stalled'});
        expect(settled).toBe(false);
        finish();
        await cancellation;
        expect(await execution.result).toEqual({status: 'cancelled', reason: 'test stop'});
        expect(jest.getTimerCount()).toBe(0);
        expect(events.filter(e => e.type === 'terminal')).toHaveLength(1);
    } finally {
        jest.useRealTimers();
    }
});

it('distinguishes human waiting from stalled tools and resets idle time only on real progress', async () => {
    jest.useFakeTimers();
    try {
        const {host, events} = setup({
            monitoring: {
                heartbeatMs: 10,
                slowAfterMs: 20,
                stalledAfterMs: 40
            }
        } as Partial<ExecutionHost>);
        let ctx: any, finish!: () => void;
        const execution = createTaskExecution(request, host, async context => {
            ctx = context;
            context.emit({type: 'tool_started', callId: 'c', tool: 'write'});
            await context.ask({id: 'q', prompt: 'Continue?', answer: 'text'}, 'c');
            await new Promise<void>(resolve => {
                finish = resolve;
            });
            return done();
        });
        await jest.advanceTimersByTimeAsync(100);
        expect((execution as any).health).toMatchObject({
            phase: 'waiting_for_input',
            condition: 'active',
            activeTools: 1
        });
        await execution.answer('q', 'yes');
        await jest.advanceTimersByTimeAsync(40);
        expect((execution as any).health).toMatchObject({phase: 'tool', condition: 'stalled', idleMs: 40});
        ctx.emit({type: 'progress', message: 'still working'});
        expect((execution as any).health).toMatchObject({condition: 'stalled', idleMs: 0});
        // A long tool remains suspect even if the model emits unrelated progress.
        ctx.emit({type: 'tool_finished', callId: 'c', tool: 'write', outcome: 'completed'});
        expect((execution as any).health.activeTools).toBe(0);
        finish();
        await execution.result;
        const count = events.length;
        await jest.advanceTimersByTimeAsync(100);
        expect(events).toHaveLength(count);
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});


it('reports excessive active duration even when the model keeps producing progress', async () => {
    jest.useFakeTimers();
    try {
        const {host} = setup({monitoring: {heartbeatMs: 10, slowAfterMs: 20, stalledAfterMs: 40}});
        let ctx: any, finish!: () => void;
        const execution = createTaskExecution(request, host, async context => {
            ctx = context;
            await new Promise<void>(resolve => {
                finish = resolve;
            });
            return done();
        });
        await jest.advanceTimersByTimeAsync(10);
        ctx.emit({type: 'progress', message: 'working'});
        await jest.advanceTimersByTimeAsync(10);
        ctx.emit({type: 'progress', message: 'working'});
        expect(execution.health).toMatchObject({condition: 'slow', elapsedMs: 20, idleMs: 0});
        finish();
        await execution.result;
    } finally {
        jest.useRealTimers();
    }
});

it.each([{heartbeatMs: 0}, {heartbeatMs: NaN}, {
    slowAfterMs: 20,
    stalledAfterMs: 10
}, {stopGraceMs: Infinity}])('rejects invalid watchdog options before side effects: %j', monitoring => {
    const {host} = setup({monitoring});
    const operation = jest.fn(async () => done());
    expect(() => createTaskExecution(request, host, operation)).toThrow(/monitoring/);
    expect(operation).not.toHaveBeenCalled();
});

it('deadline stops noncooperative work visibly and observer mutation cannot corrupt health', async () => {
    jest.useFakeTimers();
    try {
        const {host, events} = setup({
            deadlineAt: new Date(Date.now() + 25).toISOString(),
            monitoring: {heartbeatMs: 10, stopGraceMs: 10}
        });
        host.onEvent = event => {
            events.push(event);
            if (event.type === 'health') {
                event.health.phase = 'model';
                throw new Error('observer');
            }
        };
        let finish!: () => void;
        const execution = createTaskExecution(request, host, async () => {
            await new Promise<void>(resolve => {
                finish = resolve;
            });
            return done();
        });
        await jest.advanceTimersByTimeAsync(40);
        expect(execution.state).toBe('stopping');
        expect(execution.health).toMatchObject({phase: 'stopping', condition: 'stalled', stopReason: 'timeout'});
        expect(events.some(e => e.type === 'terminal')).toBe(false);
        finish();
        expect(await execution.result).toMatchObject({status: 'failed', error: {code: 'timeout', safeToReplay: false}});
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});


it('does not let unchanged usage receipts conceal a stalled provider', async () => {
    jest.useFakeTimers();
    try {
        const {host} = setup({monitoring: {heartbeatMs: 5, slowAfterMs: 10, stalledAfterMs: 20}});
        let ctx: any, finish!: () => void;
        const execution = createTaskExecution(request, host, async context => {
            ctx = context;
            await new Promise<void>(resolve => {
                finish = resolve;
            });
            return done();
        });
        await jest.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 6; i++) {
            ctx.emit({type: 'usage', usage: {inputTokens: 1, outputTokens: 1, measurement: 'reported'}});
            await jest.advanceTimersByTimeAsync(5);
        }
        expect(execution.health).toMatchObject({condition: 'stalled', idleMs: 30});
        finish();
        await execution.result;
        await jest.advanceTimersByTimeAsync(100);
        expect(execution.health).toBeUndefined();
    } finally {
        jest.useRealTimers();
    }
});

it('continues watching other tools while a specific tool waits for a human', async () => {
    jest.useFakeTimers();
    try {
        const {host} = setup({monitoring: {heartbeatMs: 5, slowAfterMs: 10, stalledAfterMs: 20}});
        const execution = createTaskExecution(request, host, async context => {
            context.emit({type: 'tool_started', callId: 'stuck', tool: 'write'});
            context.emit({type: 'tool_started', callId: 'ask', tool: 'ask_user'});
            await (context.ask as any)({id: 'q', prompt: 'Continue?', answer: 'text'}, 'ask');
            return done();
        });
        await jest.advanceTimersByTimeAsync(30);
        expect(execution.health).toMatchObject({
            phase: 'waiting_for_input', condition: 'stalled', activeTools: 2,
            stalledTools: [{callId: 'stuck', tool: 'write', elapsedMs: 30}]
        });
        await execution.answer('q', 'yes');
        await execution.result;
    } finally {
        jest.useRealTimers();
    }
});


it('pauses a tool clock over the union of overlapping questions, without double counting', async () => {
    jest.useFakeTimers();
    try {
        const {host} = setup({monitoring: {heartbeatMs: 10, slowAfterMs: 50, stalledAfterMs: 100}});
        let ctx: any, finish!: () => void;
        const execution = createTaskExecution(request, host, async context => {
            ctx = context;
            context.emit({type: 'tool_started', callId: 't', tool: 'interactive'});
            const first = context.ask({id: 'q1', prompt: 'First?', answer: 'text'}, 't');
            await new Promise(resolve => setTimeout(resolve, 10));
            const second = context.ask({id: 'q2', prompt: 'Second?', answer: 'text'}, 't');
            await Promise.all([first, second]);
            await new Promise<void>(resolve => {
                finish = resolve;
            });
            return done();
        });
        await jest.advanceTimersByTimeAsync(100);
        await execution.answer('q1', 'yes');
        await jest.advanceTimersByTimeAsync(10);
        await execution.answer('q2', 'yes');
        await jest.advanceTimersByTimeAsync(110);
        ctx.emit({type: 'progress', message: 'other progress'});
        expect(execution.health).toMatchObject({
            condition: 'stalled', idleMs: 0,
            stalledTools: [{callId: 't', tool: 'interactive', elapsedMs: 110}]
        });
        finish();
        await execution.result;
    } finally {
        jest.useRealTimers();
    }
});

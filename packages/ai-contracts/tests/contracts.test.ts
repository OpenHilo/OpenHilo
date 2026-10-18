import {
    AI_CONTRACT_VERSION,
    assertCanStart,
    type Capability,
    ContractError,
    type ExecutionHost,
    type FailureCode,
    isJsonValue,
    type TaskRequest,
    validateOutputs,
} from '../src';

const request = (): TaskRequest => ({
    version: 1, taskId: 'task-1', instruction: 'Summarize', inputs: {},
    output: {summary: 'text'}, requiredCapabilities: [],
});
const host = (): ExecutionHost => ({
    attemptId: 'attempt-1', signal: new AbortController().signal, onEvent() {
    }
});
const all: Capability[] = ['structured_output', 'workspace', 'tools', 'questions', 'continue', 'reconnect', 'usage', 'hard_budget'];

function rejects(action: () => unknown, code: FailureCode, safeToReplay = true): void {
    try {
        action();
        throw new Error('Expected ContractError');
    } catch (error) {
        expect(error).toBeInstanceOf(ContractError);
        expect((error as ContractError).failure).toMatchObject({code, safeToReplay});
    }
}

describe('serializable contracts', () => {
    test('version and request survive a JSON round trip', () => {
        expect(AI_CONTRACT_VERSION).toBe(1);
        expect(JSON.parse(JSON.stringify(request()))).toEqual(request());
    });

    test('accepts finite values, null prototypes, and shared references', () => {
        const shared = {nested: [null, false, 0, 'ok']};
        expect(isJsonValue({a: shared, b: shared})).toBe(true);
        expect(isJsonValue(Object.assign(Object.create(null), {value: 2}))).toBe(true);
    });

    test.each([undefined, NaN, Infinity, -Infinity, () => 1, Symbol('x'), BigInt(1), new Date(), new Map(), new Set(), /x/, [undefined], {value: undefined}, Array(2)])('rejects non-JSON data: %p', value => {
        expect(isJsonValue(value)).toBe(false);
    });

    test('rejects cycles, custom array fields, symbol fields, hidden data and accessors without invoking them', () => {
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        const getter = jest.fn(() => 'unsafe');
        const accessor = Object.defineProperty({}, 'value', {enumerable: true, get: getter});
        const arrayAccessor = Object.defineProperty([1], '0', {enumerable: true, get: getter});
        for (const value of [cycle, Object.assign([1], {extra: true}), {[Symbol('x')]: 1}, Object.defineProperty({}, 'hidden', {value: 1}), accessor, arrayAccessor]) {
            expect(isJsonValue(value)).toBe(false);
        }
        expect(getter).not.toHaveBeenCalled();
    });
    test('rejects array subclasses with inherited serialization hooks', () => {
        class CustomArray extends Array<number> {
            toJSON() {
                return 'changed';
            }
        }

        expect(isJsonValue(new CustomArray(1, 2))).toBe(false);
    });
});

describe('output validation', () => {
    test('validates all kinds and projects extra fields', () => {
        const output = {text: 'text', n: 'number', yes: 'boolean', any: 'json', file: 'file', dir: 'dir'} as const;
        expect(validateOutputs(output, {
            text: 'ok',
            n: 12,
            yes: false,
            any: [1, null],
            file: 'a.txt',
            dir: '/tmp/a',
            extra: 1
        }))
            .toEqual({text: 'ok', n: 12, yes: false, any: [1, null], file: 'a.txt', dir: '/tmp/a'});
    });
    test.each([{}, {summary: 1}, [], null, {
        summary: 'ok',
        extra: undefined
    }])('rejects invalid output without authorizing replay: %p', value => {
        rejects(() => validateOutputs({summary: 'text'}, value), 'invalid_output', false);
    });
    test('file/dir require strings and numbers must be finite', () => {
        rejects(() => validateOutputs({file: 'file'}, {file: {path: 'a.txt'}}), 'invalid_output', false);
        rejects(() => validateOutputs({dir: 'dir'}, {dir: 1}), 'invalid_output', false);
        rejects(() => validateOutputs({n: 'number'}, {n: NaN}), 'invalid_output', false);
    });
    test('requires own fields and safely projects special keys', () => {
        rejects(() => validateOutputs({toString: 'text' as const}, {}), 'invalid_output', false);
        const contract = JSON.parse('{"__proto__":"json"}');
        const data = JSON.parse('{"__proto__":{"polluted":true},"extra":1}');
        const result = validateOutputs(contract, data);
        expect(Object.keys(result)).toEqual(['__proto__']);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(result['__proto__']).toEqual({polluted: true});
    });
});

describe('pre-execution validation', () => {
    test('accepts ordinary requests and valid explicit state', () => {
        const value = request();
        Object.assign(value, {
            role: 'writer',
            constraints: ['brief'],
            profile: 'offline',
            context: [{namespace: 'test', version: 1, data: {}}],
            budget: {mode: 'hard', maxUsd: 0},
            continuation: {executorId: 'test', version: 1, opaqueId: 'session', workspaceId: 'ws'}
        });
        expect(() => assertCanStart(value, {
            ...host(),
            workspace: {id: 'ws', uri: 'file:///tmp/work'}
        }, 'test', all)).not.toThrow();
    });
    test.each([
        {version: 2}, {taskId: ''}, {instruction: ' '}, {inputs: []}, {inputs: {bad: undefined}},
        {role: null}, {profile: ''}, {constraints: [1]}, {context: null},
        {context: [{namespace: 'test', version: 0, data: {}}]},
        {context: [{namespace: 'test', version: 1, data: []}]},
        {budget: null}, {budget: false}, {budget: {mode: 'unknown', maxUsd: 1}},
        {budget: {mode: 'hard', maxUsd: -1}}, {budget: {mode: 'hard', maxUsd: Infinity}},
        {continuation: null}, {continuation: {executorId: 'test', version: 0, opaqueId: 'x'}},
        {requiredCapabilities: ['unknown']}, {output: []}, {output: {bad: 'unknown'}},
    ])('rejects malformed request patch %p', patch => {
        rejects(() => assertCanStart({...request(), ...patch} as TaskRequest, host(), 'test', all), 'invalid_request');
    });
    test('validates host identity, signal, callbacks, deadline, tools and workspace', () => {
        for (const patch of [{attemptId: ''}, {runId: ''}, {nodeId: ''}, {signal: null}, {onEvent: null}, {deadlineAt: 'tomorrow'}, {deadlineAt: '2026-02-30T00:00:00Z'}, {workspace: null}, {
            workspace: {
                id: '',
                uri: 'file:///tmp'
            }
        }, {tools: {}}]) {
            rejects(() => assertCanStart(request(), {...host(), ...patch} as ExecutionHost, 'test', all), 'invalid_request');
        }
        rejects(() => assertCanStart(request(), host(), '', all), 'invalid_request');
    });
    test('checks required and implied capabilities before starting', () => {
        rejects(() => assertCanStart(request(), host(), 'test', []), 'unsupported_capability');
        rejects(() => assertCanStart({
            ...request(),
            requiredCapabilities: ['questions']
        }, host(), 'test', ['structured_output']), 'unsupported_capability');
        rejects(() => assertCanStart(request(), {
            ...host(),
            workspace: {id: 'ws', uri: 'file:///tmp'}
        }, 'test', ['structured_output']), 'unsupported_capability');
        rejects(() => assertCanStart(request(), {
            ...host(),
            tools: {definitions: [], invoke: async () => ({ok: true, output: null})}
        }, 'test', ['structured_output']), 'unsupported_capability');
        rejects(() => assertCanStart({
            ...request(),
            budget: {mode: 'hard', maxUsd: 1}
        }, host(), 'test', ['structured_output']), 'unsupported_capability');
        rejects(() => assertCanStart({
            ...request(),
            continuation: {executorId: 'test', version: 1, opaqueId: 's'}
        }, host(), 'test', ['structured_output']), 'unsupported_capability');
        expect(() => assertCanStart({
            ...request(),
            budget: {mode: 'advisory', maxUsd: 1}
        }, host(), 'test', ['structured_output'])).not.toThrow();
    });
    test('required workspace/tools need host resources', () => {
        for (const capability of ['workspace', 'tools'] as const) {
            rejects(() => assertCanStart({
                ...request(),
                requiredCapabilities: [capability]
            }, host(), 'test', all), 'invalid_request');
        }
    });
    test('rejects sparse tool definitions before capability negotiation', () => {
        rejects(() => assertCanStart(request(), {
            ...host(),
            tools: {definitions: new Array(1), invoke: async () => ({ok: true, output: null})}
        }, 'test', all), 'invalid_request');
    });
    test('session executor and workspace must match', () => {
        for (const continuation of [{executorId: 'other', version: 1, opaqueId: 's'}, {
            executorId: 'test',
            version: 1,
            opaqueId: 's',
            workspaceId: 'other'
        }]) {
            rejects(() => assertCanStart({...request(), continuation}, host(), 'test', all), 'invalid_request');
        }
    });
});

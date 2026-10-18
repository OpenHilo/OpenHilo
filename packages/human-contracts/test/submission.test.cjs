const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateHumanSubmission, HumanOutputError} = require('@openhilo/human-contracts');
const request = {
    version: 1,
    taskId: 'task-1',
    runId: 'run-1',
    nodeId: 'review',
    nodeRunId: 'nr-1',
    prompt: 'Review',
    inputs: {},
    outputs: {n: 'number', note: 'text'},
    createdAt: '2026-10-03T00:00:00Z'
};
const valid = {taskId: 'task-1', submissionId: 'submission-1', outputs: {n: ' 1e2 ', note: '  keep whitespace  '}};

test('new submissions carry only results; explicit old decisions cannot create new submissions', () => {
    assert.deepEqual(validateHumanSubmission(request, valid), valid);
    for (const decision of ['confirm', 'reject']) assert.throws(() => validateHumanSubmission(request, {
        ...valid,
        decision
    }), HumanOutputError);
});
test('invalid shapes, unsafe opaque ids and a different task cannot be submitted', () => {
    for (const input of [null, [], 'confirm', {}, {...valid, decision: 'yes'}, {...valid, taskId: 'other'}, {
        ...valid,
        extra: true
    }]) {
        assert.throws(() => validateHumanSubmission(request, input), HumanOutputError);
    }
    for (const id of ['', ' ', '../task', 'a/b', 'a\\b', 'a\n', 'a'.repeat(201), 10]) {
        assert.throws(() => validateHumanSubmission(request, {...valid, submissionId: id}), HumanOutputError);
    }
    assert.doesNotThrow(() => validateHumanSubmission(request, {...valid, submissionId: 'a'.repeat(200)}));
});

test('submission validates every declared business output', () => {
    for (const outputs of [{n: '1x', note: ''}, {n: 'Infinity', note: ''}, {n: 1, note: ''}, {n: '1'}, {
        n: '1',
        note: '',
        extra: ''
    }, null, []]) {
        assert.throws(() => validateHumanSubmission(request, {...valid, outputs}), HumanOutputError);
    }
    assert.throws(() => validateHumanSubmission(request, {...valid, decision: 'reject'}), HumanOutputError);
    assert.throws(() => validateHumanSubmission({...request, outputs: {b: 'boolean', j: 'json'}}, {
        ...valid,
        outputs: {b: 'true', j: '{broken'}
    }), HumanOutputError);
    assert.doesNotThrow(() => validateHumanSubmission({...request, outputs: {}}, {...valid, outputs: {}}));
});

test('negative zero is rejected before a decision can be persisted lossily', () => {
    assert.throws(() => validateHumanSubmission(request, {...valid, outputs: {n: '-0', note: ''}}), HumanOutputError);
    assert.throws(() => validateHumanSubmission({...request, outputs: {j: 'json'}}, {
        ...valid,
        outputs: {j: '{"value":-0}'}
    }), HumanOutputError);
});

import type {Value, ValueType} from '@openhilo/itt-contracts';
import {HumanOutputError, parseHumanOutputs} from '@openhilo/itt-contracts/human-output';

export {HumanOutputError} from '@openhilo/itt-contracts/human-output';

export interface HumanTaskRequest {
    version: 1;
    taskId: string;
    runId: string;
    nodeId: string;
    nodeRunId: string;
    prompt: string;
    inputs: Record<string, Value>;
    outputs: Record<string, ValueType>;
    createdAt: string;
}

export interface HumanSubmission {
    taskId: string;
    submissionId: string;
    outputs: Record<string, string>;
}

export interface HumanSubmissionReceipt {
    status: 'accepted' | 'duplicate' | 'conflict' | 'stale' | 'invalid';
    taskId: string;
    submissionId: string;
    message?: string;
}

export interface HumanTaskHost {
    signal: AbortSignal;

    submit(submission: HumanSubmission): Promise<HumanSubmissionReceipt>;
}

export interface HumanExecutor {
    id: string;

    present(request: HumanTaskRequest, host: HumanTaskHost): Promise<void>;
}

/** Validate the complete string-wire submission without mutating the task or its outputs. */
export function validateHumanSubmission(request: HumanTaskRequest, value: unknown): HumanSubmission {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new HumanOutputError('Human submission must be an object');
    }
    const input = value as Record<string, unknown>;
    const fields = ['taskId', 'submissionId', 'outputs'];
    if (Object.keys(input).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(input, key))) {
        throw new HumanOutputError('Human submission requires exactly taskId, submissionId, and outputs');
    }
    for (const key of ['taskId', 'submissionId'] as const) {
        if (typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input[key])) {
            throw new HumanOutputError(`${key} must be a safe opaque ID of 1–200 letters, digits, underscores, or hyphens`);
        }
    }
    if (input.taskId !== request.taskId) throw new HumanOutputError('Submission taskId does not match the human task');
    parseHumanOutputs(input.outputs, request.outputs);
    return {
        taskId: input.taskId as string,
        submissionId: input.submissionId as string,
        outputs: Object.fromEntries(Object.entries(input.outputs as Record<string, string>)),
    };
}

/** Durable human operations. Presentation adapters never own workflow state. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {
    type HumanSubmission,
    type HumanSubmissionReceipt,
    type HumanTaskRequest,
    validateHumanSubmission
} from '@openhilo/human-contracts';

function taskDir(runDir: string, taskId: string): string {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) throw new Error('Invalid human task ID');
    return path.join(runDir, 'human-tasks', taskId);
}

function read<T>(file: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

/** Publish a complete file without replacing a competing writer's accepted result. */
function publish(file: string, value: unknown): boolean {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temporary = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.linkSync(temporary, file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
    } finally {
        fs.unlinkSync(temporary);
    }
}

export function persistHumanTask(runDir: string, request: HumanTaskRequest): void {
    if (!publish(path.join(taskDir(runDir, request.taskId), 'request.json'), request)) throw new Error('Human task already exists');
}

export function readHumanTask(runDir: string, taskId: string): HumanTaskRequest | undefined {
    return read(path.join(taskDir(runDir, taskId), 'request.json'));
}

export function readHumanSubmission(runDir: string, taskId: string): HumanSubmission | undefined {
    const value = read<unknown>(path.join(taskDir(runDir, taskId), 'submission.json'));
    if (value === undefined) return undefined;
    const request = readHumanTask(runDir, taskId);
    if (!request) throw new Error('Saved human result has no task request');
    return validateHumanSubmission(request, value);
}

/** Only a final suspension checkpoint authorizes accepting a new result. */
export function currentHumanTask(runDir: string): HumanTaskRequest | undefined {
    const record = read<{ status: string }>(path.join(runDir, 'run.json'));
    if (record && ['completed', 'aborted'].includes(record.status)) return undefined;
    let lines: string[];
    try {
        lines = fs.readFileSync(path.join(runDir, 'execution.jsonl'), 'utf8').trim().split('\n').filter(line => line.trim());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    let last: { event: string };
    try {
        last = JSON.parse(lines.at(-1)!);
    } catch {
        return undefined;
    }
    if (last?.event !== 'suspended_state') return undefined;
    for (let index = lines.length - 2; index >= 0; index--) {
        let event;
        try {
            event = JSON.parse(lines[index]);
        } catch {
            continue;
        }
        if (!event) continue;
        if (event.event === 'node_suspended') return typeof event.task_id === 'string' ? readHumanTask(runDir, event.task_id) : undefined;
        if (['run_start', 'run_resume', 'run_failed'].includes(event.event)) return undefined;
    }
    return undefined;
}

function equivalent(a: HumanSubmission, b: HumanSubmission): boolean {
    return a.taskId === b.taskId && a.submissionId === b.submissionId &&
        Object.keys(a.outputs).length === Object.keys(b.outputs).length && Object.entries(a.outputs).every(([key, value]) => Object.hasOwn(b.outputs, key) && b.outputs[key] === value);
}

export function submitHumanTask(runDir: string, input: HumanSubmission): HumanSubmissionReceipt {
    const receipt = (status: HumanSubmissionReceipt['status'], message?: string): HumanSubmissionReceipt => ({
        status,
        taskId: typeof input?.taskId === 'string' ? input.taskId : '',
        submissionId: typeof input?.submissionId === 'string' ? input.submissionId : '', ...(message ? {message} : {}),
    });
    let request: HumanTaskRequest | undefined, submission: HumanSubmission, previous: HumanSubmission | undefined;
    try {
        request = readHumanTask(runDir, input?.taskId);
        if (!request) return receipt('stale', 'Human task no longer exists');
        previous = readHumanSubmission(runDir, request.taskId);
        submission = validateHumanSubmission(request, input);
    } catch (error) {
        return receipt('invalid', (error as Error).message);
    }
    if (previous) return equivalent(previous, submission) ? receipt('duplicate') : receipt('conflict', 'Human task already has a different result');
    if (currentHumanTask(runDir)?.taskId !== request.taskId) return receipt('stale', 'Human task is no longer current');
    if (publish(path.join(taskDir(runDir, request.taskId), 'submission.json'), submission)) return receipt('accepted');
    return equivalent(readHumanSubmission(runDir, request.taskId)!, submission) ? receipt('duplicate') : receipt('conflict', 'Human task already has a different result');
}

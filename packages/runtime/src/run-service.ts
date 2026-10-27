import {randomUUID} from 'node:crypto';
import {type HumanExecutor, type HumanSubmission, validateHumanSubmission} from '@openhilo/human-contracts';
import {currentHumanTask, readHumanSubmission, submitHumanTask} from './human-tasks';
import {parseRunInputs, type RunInputEncoding, validateRunInputWire} from '@openhilo/itt-contracts/run-inputs';
import {assertWorkflowValue} from './workflow-value';
import {ScopeManager} from './scope-manager';
import {HumanOutputError, parseHumanOutputs} from '@openhilo/itt-contracts/human-output';
import {readSnapshot} from './snapshot';
/** File-backed run orchestration with explicit snapshot and executor composition. */
import * as fs from 'fs';
import * as path from 'path';
import {isJsonValue, type JsonObject} from '@openhilo/ai-contracts';
import {type CFGITT, type IttValidationResult, IttValidator, type Value} from '@openhilo/itt-contracts';
import {
  AbortError,
  FailableError,
  type LogEvent,
  type RunStatus,
  type RuntimeExtensionPolicy
} from '@openhilo/runtime-contracts';
import {RunManager} from './run-manager';
import {ExecutionEngine, type ExecutorFn, HumanSuspendedError, validateCheckpoint} from './execution-engine';
import {EvalEngine} from './eval-engine';
import {Rehydrator} from './rehydrator';
import {Logger} from './logger';

export interface RunContext {
    runId: string;
    runDir: string;
    workdir: string;
    snapshotDir: string;
    entryIntent: string;
    aiRoutingIdentity?: string;
}

export interface RunResources {
    humanExecutor?: HumanExecutor;
    executor: ExecutorFn;

    close?(): void | Promise<void>
}

export interface RunComposition {
    /** Automatically supplied by the configured routing executor. */
    aiRoutingIdentity?: string;
    humanExecutor?: HumanExecutor;
    extensions?: readonly RuntimeExtensionPolicy[];
    allowLegacyExtensionRestore?: boolean;
    humanMode?: 'interactive' | 'suspend';
    checkpointsEnabled?: boolean;

    createResources(context: RunContext): RunResources | Promise<RunResources>;

    onEvent?(event: LogEvent): void;
}

export interface StartRunOpts extends RunComposition {
    intent: string;
    entryFile: string;
    workdir: string;
    runsDir: string;
    inputs: Record<string, string>;
    inputEncoding?: RunInputEncoding;
    /** Application/provider selection receipt; runtime-owned keys may not be replaced. */
    receipt?: JsonObject;

    populateSnapshot(context: RunContext): void | Promise<void>;

    onRunCreated?(runId: string, runDir: string): void | Promise<void>;
}

export interface ResumeRunOpts extends RunComposition {
    runDir: string;
    humanSubmission?: HumanSubmission;
    humanOutput?: Record<string, string>;
    humanNodeRunId?: string;
    /** Explicit user retry of this failed invocation; never inferred for automatic replay. */
    retryFailedNode?: string;
}

export interface StartRunResult {
    runDir: string;
    runId: string;
    status: RunStatus
}

export function parseKvPairs(pairs: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const pair of pairs) {
        const index = pair.indexOf('=');
        if (index === -1) throw new Error(`Invalid key=value pair: "${pair}"`);
        result[pair.slice(0, index)] = pair.slice(index + 1);
    }
    return result;
}

export function validateFile(filePath: string): IttValidationResult {
    return new IttValidator().validate(JSON.parse(fs.readFileSync(filePath, 'utf8')) as CFGITT);
}

function validateRoutingIdentity(identity: unknown): void {
    if (identity !== undefined && (typeof identity !== 'string' || !identity.trim())) throw new Error('AI routing configuration identity must be a nonempty string');
}

export async function startRun(options: StartRunOpts): Promise<StartRunResult> {
    validateRoutingIdentity(options.aiRoutingIdentity);
    assertWorkflowValue(options.inputs);
    validateRunInputWire(options.inputs, options.inputEncoding);
    const reserved = ['run_id', 'intent', 'workdir', 'status', 'created_at', 'updated_at', 'entry_intent', 'inputEncoding', 'ai_routing_identity'];
    if (options.receipt && (!isJsonValue(options.receipt) || reserved.some(key => Object.hasOwn(options.receipt!, key)))) {
        throw new Error('Run receipt must contain JSON metadata without runtime-owned keys');
    }
    fs.mkdirSync(options.workdir, {recursive: true});
    const manager = RunManager.create(options);
    const context: RunContext = {
        aiRoutingIdentity: options.aiRoutingIdentity,
        runId: manager.runId,
        runDir: manager.runDir,
        workdir: options.workdir,
        snapshotDir: path.join(manager.runDir, '.snapshot'),
        entryIntent: path.basename(options.entryFile).replace(/\.itt\.(impl\.)?json$/, '')
    };
    let inputs: Record<string, Value>;
    try {
        const file = path.join(manager.runDir, 'run.json');
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        const temporary = `${file}.${process.pid}.receipt.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify({
                ...record, ...options.receipt,
                ...(options.aiRoutingIdentity !== undefined ? {ai_routing_identity: options.aiRoutingIdentity} : {}),
                entry_intent: context.entryIntent, ...(options.inputEncoding ? {inputEncoding: options.inputEncoding} : {})
            }, null, 2), {flag: 'wx', mode: 0o600});
            fs.renameSync(temporary, file);
        } finally {
            fs.rmSync(temporary, {force: true});
        }
        await options.onRunCreated?.(manager.runId, manager.runDir);
        await options.populateSnapshot(context);
        const entry = path.join(context.snapshotDir, path.basename(options.entryFile));
        const validation = validateFile(entry);
        if (validation.errors.length) throw new Error(`Validation errors:\n${validation.errors.join('\n')}`);
        inputs = parseRunInputs(options.inputs, (JSON.parse(fs.readFileSync(entry, 'utf8')) as CFGITT).inputs ?? {}, options.inputEncoding);
        assertWorkflowValue(inputs);
    } catch (error) {
        try {
            manager.update_status('aborted');
            const event: LogEvent = {
                event: 'run_abort', ts: Math.floor(Date.now() / 1000), node_run_id: null,
                reason: error instanceof Error ? error.message : String(error)
            };
            new Logger(context.runDir, context.runId).append(event);
            options.onEvent?.(event);
        } finally {
            manager.release();
        }
        throw error;
    }
    return execute(options, context, manager, {inputs});
}

/** Read-only validation is repeated under ownership before accepting any input. */
function prepareResume(options: ResumeRunOpts) {
    const record = JSON.parse(fs.readFileSync(path.join(options.runDir, 'run.json'), 'utf8'));
    validateRoutingIdentity(options.aiRoutingIdentity);
    validateRoutingIdentity(record.ai_routing_identity);
    if (record.ai_routing_identity !== options.aiRoutingIdentity) throw new Error('AI routing configuration changed or is missing; restore the original configuration to resume this run');
    if (options.retryFailedNode !== undefined && (record.status !== 'failed' || typeof options.retryFailedNode !== 'string' || !options.retryFailedNode || options.humanOutput !== undefined || options.humanSubmission !== undefined)) throw new Error('Explicit failure retry requires the current failed run without human answers');
    const task = currentHumanTask(options.runDir);
    if (options.humanNodeRunId !== undefined && task) {
        const current = new Rehydrator(options.runDir).rehydrate(undefined, true);
        if (current.kind !== 'ok' || current.humanNodeRunId !== options.humanNodeRunId) {
            throw new HumanOutputError('Human operation is no longer current; reload the pending task');
        }
    }
    if (options.humanSubmission && options.humanSubmission.taskId !== task?.taskId) throw new HumanOutputError('Human operation is no longer current; reload the pending task');
    if (options.humanSubmission && options.humanOutput !== undefined) throw new HumanOutputError('Provide either humanSubmission or humanOutput');
    const submission = options.humanSubmission ?? (task && options.humanOutput !== undefined ? {
        taskId: task.taskId, submissionId: randomUUID(), outputs: options.humanOutput,
    } : undefined);
    const state = new Rehydrator(options.runDir).rehydrate(options.humanOutput, !!task, options.retryFailedNode);
    if (state.kind === 'no_suspended_state') throw new Error('resumeRun: no suspended state found in this run directory');
    if (state.kind === 'suspended_no_output') throw new Error('resumeRun: run is suspended at a human node — provide --human-output');
    if (state.kind === 'unsafe_to_replay') throw new Error(`resumeRun: node ${state.nodeRunId} is unsafe to replay; inspect its effects before starting new work`);
    const {callStack, globalSeq, pendingHumanOutput, pendingHumanTask} = state;
    const {pendingHumanSubmission} = state;
    // A Human answer must never be dropped while a failed step is retried in its place.
    if (options.humanOutput !== undefined && state.humanNodeRunId === undefined) {
        throw new HumanOutputError('resumeRun: run is not suspended at a human node; omit humanOutput');
    }
    // Preflight spans separate reads; another owner may advance between them.
    // Never bind an answer read for one task to a newer checkpoint.
    if (task?.taskId !== pendingHumanTask?.taskId) {
        throw new HumanOutputError('Human operation is no longer current; reload the pending task');
    }
    if (pendingHumanSubmission) {
        if (!task) throw new HumanOutputError('Human operation is no longer current');
        validateHumanSubmission(task, pendingHumanSubmission);
    }
    if (options.humanNodeRunId !== undefined && options.humanNodeRunId !== state.humanNodeRunId) {
        throw new HumanOutputError('Human operation is no longer current; reload the pending task');
    }
    const submissionToValidate = submission ?? pendingHumanSubmission;
    if (submission && task) validateHumanSubmission(task, submission);
    if (pendingHumanOutput !== undefined || submissionToValidate) {
        const frame = callStack.at(-1);
        if (!frame || typeof frame.intent_name !== 'string' || typeof frame.current_node !== 'string') throw new HumanOutputError('Invalid suspended human frame');
        const node = readSnapshot(path.join(options.runDir, '.snapshot'), frame.intent_name).nodes?.[frame.current_node];
        if (!node || node.type !== 'call' || node.executor !== 'human') throw new HumanOutputError('Suspended node is not a human operation');
        parseHumanOutputs(submissionToValidate ? submissionToValidate.outputs : pendingHumanOutput, Object.fromEntries(Object.keys(node.outputsTo).map(field => [field, node.outputs?.[field] ?? 'text'])));
    }
    // Reject lossy saved values, edited snapshots and extension mismatches before taking a lock,
    // changing status or creating resources; the checkpoint remains available for a corrected caller.
    validateCheckpoint({
        snapshotDir: path.join(options.runDir, '.snapshot'), callStack,
        extensions: options.extensions, allowLegacyExtensionRestore: options.allowLegacyExtensionRestore
    });
    for (const frame of callStack) new ScopeManager().deserialize(frame.scope_stack);
    return {record, submission, callStack, globalSeq, pendingHumanOutput, pendingHumanSubmission, pendingHumanTask, humanNodeRunId: state.humanNodeRunId};
}

export async function resumeRun(options: ResumeRunOpts): Promise<StartRunResult> {
    const before = prepareResume(options);
    const manager = RunManager.resume(options.runDir);
    try {
        const prepared = prepareResume(options);
        if (options.humanOutput !== undefined && (prepared.humanNodeRunId !== before.humanNodeRunId ||
            prepared.submission?.taskId !== before.submission?.taskId ||
            prepared.pendingHumanTask?.taskId !== before.pendingHumanTask?.taskId)) {
            throw new HumanOutputError('Human operation is no longer current; reload the pending task');
        }
        const {record, submission, callStack, globalSeq, pendingHumanOutput, pendingHumanTask} = prepared;
        let {pendingHumanSubmission} = prepared;
        if (submission) {
            // Legacy callers lack a receipt ID; preserve it when retrying the same answer.
            const previous = readHumanSubmission(options.runDir, submission.taskId);
            if (!options.humanSubmission && previous) submission.submissionId = previous.submissionId;
            const receipt = submitHumanTask(options.runDir, submission);
            if (!['accepted', 'duplicate'].includes(receipt.status)) throw new HumanOutputError(receipt.message ?? receipt.status);
            pendingHumanSubmission = readHumanSubmission(options.runDir, submission.taskId);
        }
        const context: RunContext = {
            aiRoutingIdentity: options.aiRoutingIdentity,
            runId: manager.runId, runDir: options.runDir, workdir: record.workdir,
            snapshotDir: path.join(options.runDir, '.snapshot'),
            entryIntent: typeof record.entry_intent === 'string' ? record.entry_intent : callStack[0]?.intent_name ?? record.intent
        };
        // Return without awaiting so preflight/checkpoint graphs are not retained
        // by this frame during a later Human wait. Ownership lasts until cleanup.
        return execute({...options, humanMode: options.humanMode ?? 'suspend'}, context, manager,
            {inputs: {}, resumeFrom: {callStack, globalSeq}, pendingHumanOutput, pendingHumanSubmission, pendingHumanTask})
            .finally(() => manager.release());
    } catch (error) {
        // Under-lock validation can fail before execute owns cleanup.
        manager.release();
        throw error;
    }
}

async function execute(options: RunComposition, context: RunContext, manager: RunManager,
                       state: Pick<ConstructorParameters<typeof ExecutionEngine>[0], 'inputs' | 'resumeFrom' | 'pendingHumanOutput' | 'pendingHumanSubmission' | 'pendingHumanTask'>): Promise<StartRunResult> {
    const evalEngine = new EvalEngine();
    const resumedAtHuman = !!state.pendingHumanTask;
    let resources: RunResources | undefined;
    const result = (status: RunStatus): StartRunResult => ({runDir: context.runDir, runId: context.runId, status});
    try {
        resources = await options.createResources(context);
        if (state.pendingHumanTask && !state.pendingHumanSubmission && !state.pendingHumanOutput && !options.humanExecutor && !resources.humanExecutor) {
            throw new HumanOutputError('resumeRun: run is suspended at a human node — provide --human-output or a humanExecutor');
        }
        evalEngine.start();
        const engine = new ExecutionEngine({
            runId: context.runId, runDir: context.runDir, workdir: context.workdir,
            snapshotDir: context.snapshotDir, intentName: context.entryIntent, ...state,
            evalEngine, runManager: manager, executor: resources.executor,
            humanExecutor: options.humanExecutor ?? resources.humanExecutor,
            humanMode: options.humanMode, checkpointsEnabled: options.checkpointsEnabled, onEvent: options.onEvent,
            extensions: options.extensions, allowLegacyExtensionRestore: options.allowLegacyExtensionRestore
        });
        // ExecutionEngine owns the initial state; drop the redundant recovery graph.
        state = {inputs: {}};
        await engine.run();
        return result('completed');
    } catch (error) {
        if (error instanceof HumanOutputError && resumedAtHuman) {
            manager.update_status('suspended');
            throw error;
        }
        if (error instanceof HumanSuspendedError) return result('suspended');
        if (error instanceof AbortError) {
            manager.update_status('aborted');
            return result('aborted');
        }
        if (error instanceof FailableError) {
            // Non-resumable executors (sys) already recorded run_abort and an aborted status.
            if (manager.status === 'aborted') return result('aborted');
            manager.update_status('failed');
            return result('failed');
        }
        manager.update_status('failed');
        throw error;
    } finally {
        try {
            try {
                await evalEngine.stop();
            } finally {
                await resources?.close?.();
            }
        } finally {
            manager.release();
        }
    }
}

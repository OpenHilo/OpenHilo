export const AI_CONTRACT_VERSION = 1 as const;
export type {
    JsonValue, JsonObject, ValueKind, OutputContract, Capability, ExtensionState, SessionRef,
    TaskRequest, Artifact, Usage, FailureCode, Failure, TaskResult, Availability,
} from './data';
export type {
    Question, EventPayload, TaskEvent, ToolDefinition, ToolHost, ExecutionHost,
    ExecutionState, ExecutionHealth, ExecutionMonitoring, AnswerReceipt, AiExecution, AiTaskExecutor,
} from './execution';
export {ContractError, isJsonValue, validateOutputs, assertCanStart} from './validation';
export {createTaskExecution, type TaskOperationContext} from './task-execution';

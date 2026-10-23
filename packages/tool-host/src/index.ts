import Ajv, {type ValidateFunction} from 'ajv';
import addFormats from 'ajv-formats';
import {type Failure, isJsonValue, type JsonObject, type ToolDefinition, type ToolHost} from '@openhilo/ai-contracts';

export interface RegisteredTool extends ToolDefinition {
    /** Only set for operations that cannot mutate external state. */
    readOnly?: boolean;

    handler(arguments_: JsonObject, context: { callId: string; signal: AbortSignal }): Promise<unknown>;
}

type Result = Awaited<ReturnType<ToolHost['invoke']>>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const failure = (code: Failure['code'], message: string, safeToReplay: boolean): Result =>
    ({ok: false, error: {code, message, retryable: false, safeToReplay}});

/** One immutable registry per host. No automatic retries or durable deduplication. */
export function createToolHost(tools: readonly RegisteredTool[]): ToolHost {
    const entries = new Map<string, {
        definition: ToolDefinition; validate: ValidateFunction;
        handler: RegisteredTool['handler']; readOnly: boolean
    }>();
    for (const tool of tools) {
        if (!tool.name?.trim() || entries.has(tool.name)) throw new Error(`Invalid or duplicate tool name: ${tool.name}`);
        if (typeof tool.description !== 'string' || typeof tool.handler !== 'function') throw new Error(`Invalid tool: ${tool.name}`);
        if (!isJsonValue(tool.inputSchema) || tool.inputSchema === null || Array.isArray(tool.inputSchema)
            || tool.inputSchema.type !== 'object') throw new Error(`Tool ${tool.name} needs a JSON object schema`);
        const definition = copy({name: tool.name, description: tool.description, inputSchema: tool.inputSchema});
        // Separate validators prevent unrelated tools' local $id declarations from colliding.
        const ajv = new Ajv({
            allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false,
            coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true
        });
        addFormats(ajv);
        const validate = ajv.compile(definition.inputSchema);
        if ('$async' in validate && validate.$async) throw new Error(`Async schemas are not supported: ${tool.name}`);
        entries.set(tool.name, {definition, validate, handler: tool.handler, readOnly: tool.readOnly === true});
    }
    return {
        get definitions() {
            return [...entries.values()].map(entry => copy(entry.definition));
        },
        async invoke(call, signal): Promise<Result> {
            if (!isJsonValue(call) || !call || typeof call.callId !== 'string' || !call.callId.trim()
                || typeof call.name !== 'string' || !call.arguments || Array.isArray(call.arguments)
                || typeof call.arguments !== 'object') return failure('invalid_request', 'Invalid tool call envelope', true);
            const entry = entries.get(call.name);
            if (!entry) return failure('invalid_request', `Unknown tool: ${call.name}`, true);
            const args = copy(call.arguments);
            if (!entry.validate(args)) return failure('invalid_request',
                `Invalid arguments for ${call.name}: ${new Ajv().errorsText(entry.validate.errors)}`, true);
            if (signal.aborted) return failure('tool_failed', `Tool cancelled before invocation: ${call.name}`, true);
            try {
                // Wait for cooperative cleanup. A late success remains authoritative even after abort.
                const output = await entry.handler(args, {callId: call.callId, signal});
                if (!isJsonValue(output)) return failure('invalid_output', `Non-JSON tool output: ${call.name}`, entry.readOnly);
                return {ok: true, output: copy(output)};
            } catch (error) {
                // Once a mutating handler starts, an exception does not prove it had no effect.
                return failure(entry.readOnly ? 'tool_failed' : 'outcome_unknown',
                    error instanceof Error ? error.message : 'Tool handler failed', entry.readOnly);
            }
        },
    };
}

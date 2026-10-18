import OpenAI from 'openai';
import type {ResponseInput, ResponseInputItem} from 'openai/resources/responses/responses';
import type {TaskRequest, ToolDefinition} from '@openhilo/ai-contracts';
import {clone, type ModelConversation, type ModelResult, protocol, taskText} from './model';
import {fail} from './errors';

export interface OpenAIProfile {
    provider: 'openai';
    model: string;
    client: OpenAI;
    maxOutputTokens?: number
}

export function openAIConversation(profile: OpenAIProfile): ModelConversation {
    const input: ResponseInput = [];
    return {
        append(request: TaskRequest) {
            input.push({role: 'user', content: taskText(request)});
        },
        async next(tools: readonly ToolDefinition[], signal: AbortSignal) {
            const response = await profile.client.responses.create({
                model: profile.model, instructions: protocol,
                input: clone(input), store: false, include: ['reasoning.encrypted_content'],
                tools: tools.map(tool => ({
                    type: 'function',
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                    strict: false
                })),
                parallel_tool_calls: false, ...(profile.maxOutputTokens ? {max_output_tokens: profile.maxOutputTokens} : {}),
            }, {signal, maxRetries: 0});
            if (response.status !== 'completed') return fail('invalid_output', `OpenAI response did not complete (${response.status ?? 'unknown'})`);
            // Keep reasoning, encrypted state, messages and call IDs intact; never flatten to text.
            input.push(...clone(response.output) as ResponseInputItem[]);
            const calls = response.output.filter(item => item.type === 'function_call').map(item => {
                if (item.status && item.status !== 'completed') return fail('invalid_output', 'Incomplete OpenAI function call');
                let arguments_: unknown;
                try {
                    arguments_ = JSON.parse(item.arguments);
                } catch {
                    return fail('invalid_output', 'Malformed OpenAI function arguments');
                }
                return {id: item.call_id, name: item.name, arguments: arguments_};
            });
            return {
                calls, ...(response.usage ? {
                    usage: {
                        inputTokens: response.usage.input_tokens,
                        outputTokens: response.usage.output_tokens,
                        measurement: 'reported' as const
                    }
                } : {})
            };
        },
        submit(results: ModelResult[]) {
            input.push(...results.map(result => ({
                type: 'function_call_output' as const,
                call_id: result.id,
                output: JSON.stringify(result.result)
            })));
        },
    };
}

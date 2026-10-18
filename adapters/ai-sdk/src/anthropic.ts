import Anthropic from '@anthropic-ai/sdk';
import type {ContentBlockParam, MessageParam} from '@anthropic-ai/sdk/resources/messages';
import type {TaskRequest, ToolDefinition} from '@openhilo/ai-contracts';
import {clone, type ModelConversation, type ModelResult, protocol, taskText} from './model';
import {fail} from './errors';

export interface AnthropicProfile {
    provider: 'anthropic';
    model: string;
    client: Anthropic;
    maxOutputTokens?: number
}

export function anthropicConversation(profile: AnthropicProfile): ModelConversation {
    const messages: MessageParam[] = [];
    return {
        append(request: TaskRequest) {
            messages.push({role: 'user', content: taskText(request)});
        },
        async next(tools: readonly ToolDefinition[], signal: AbortSignal) {
            const response = await profile.client.messages.create({
                model: profile.model, system: protocol,
                max_tokens: profile.maxOutputTokens ?? 4096, messages: clone(messages),
                tools: tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: {...tool.inputSchema, type: 'object' as const}
                })),
            }, {signal, maxRetries: 0});
            if (!['tool_use', 'end_turn'].includes(response.stop_reason ?? '')) return fail('invalid_output', `Anthropic response did not complete (${response.stop_reason ?? 'unknown'})`);
            messages.push({role: 'assistant', content: clone(response.content) as ContentBlockParam[]});
            return {
                calls: response.content.filter(item => item.type === 'tool_use').map(item => ({
                    id: item.id,
                    name: item.name,
                    arguments: clone(item.input)
                })),
                usage: {
                    inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0),
                    outputTokens: response.usage.output_tokens, measurement: 'reported' as const
                }
            };
        },
        submit(results: ModelResult[]) {
            // Every tool_use in the assistant message receives a result in the immediately following user message.
            messages.push({
                role: 'user', content: results.map(result => ({
                    type: 'tool_result' as const, tool_use_id: result.id,
                    content: JSON.stringify(result.result), is_error: !result.result.ok
                }))
            });
        },
    };
}

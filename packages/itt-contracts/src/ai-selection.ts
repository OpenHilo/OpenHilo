/** Deployment-neutral selection of an AI execution configuration. */
export const AI_TYPES = ['default', 'general', 'reasoning', 'coding', 'writing', 'search'] as const;
export const AI_LEVELS = ['light', 'medium', 'pro', 'max'] as const;
export type AiType = typeof AI_TYPES[number];
export type AiLevel = typeof AI_LEVELS[number];
export interface AiSelection { type?: AiType; level?: AiLevel }

export function parseAiSelection(value: unknown): AiSelection {
    const fail = (message: string): never => { throw new Error(`AI selection: ${message}`); };
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('expected an object');
    const result: AiSelection = {};
    for (const key of Reflect.ownKeys(value)) {
        if (key !== 'type' && key !== 'level') return fail('unknown field');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor) || !descriptor.enumerable) return fail('expected plain data');
        const field = descriptor.value;
        if (key === 'type') {
            if (!(AI_TYPES as readonly unknown[]).includes(field)) return fail('type must be default, general, reasoning, coding, writing or search');
            result.type = field;
        } else {
            if (!(AI_LEVELS as readonly unknown[]).includes(field)) return fail('level must be light, medium, pro or max');
            result.level = field;
        }
    }
    return result;
}

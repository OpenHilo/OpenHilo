import type {Value, ValueType} from './index';

/** Invalid user input; callers decide whether to display it, reject HTTP, or abort a live node. */
export class HumanOutputError extends Error {
    constructor(message: string, public readonly field?: string) {
        super(message);
        this.name = 'HumanOutputError';
    }
}

/** String wire format used by existing CLI and Web human-node submissions. */
export function parseHumanOutputValue(raw: unknown, kind: ValueType, field: string): Value {
    if (typeof raw !== 'string') throw new HumanOutputError(`Human output field ${field} must be a string`, field);
    switch (kind) {
        case 'number': {
            // Decimal/scientific syntax only; parseFloat would silently accept a valid prefix.
            const value = raw.trim();
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Object.is(Number(value), -0)) {
                throw new HumanOutputError(`Invalid number for field ${field}`, field);
            }
            return Number(value);
        }
        case 'boolean':
            if (raw === 'true') return true;
            if (raw === 'false') return false;
            throw new HumanOutputError(`Invalid boolean for field ${field}`, field);
        case 'json':
            try {
                return JSON.parse(raw, (_key, value: unknown) => {
                    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) throw new Error('Non-finite JSON number');
                    return value;
                }) as Value;
            } catch {
                throw new HumanOutputError(`Invalid JSON for field ${field}`, field);
            }
        case 'text':
        case 'file':
        case 'dir':
            return raw;
        default:
            throw new HumanOutputError(`Unsupported human output type for field ${field}`, field);
    }
}

/** Validate the complete output before callers mutate workflow scope or resume a run. */
export function parseHumanOutputs(raw: unknown, outputs: Record<string, ValueType>): Record<string, Value> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HumanOutputError('humanOutput must be an object containing string values');
    const input = raw as Record<string, unknown>;
    for (const field of Object.keys(input)) {
        if (!Object.hasOwn(outputs, field)) throw new HumanOutputError(`Unknown human output field: ${field}`, field);
    }
    const entries = Object.entries(outputs).map(([field, kind]) => {
        if (!Object.hasOwn(input, field)) throw new HumanOutputError(`Missing human output field: ${field}`, field);
        return [field, parseHumanOutputValue(input[field], kind, field)] as const;
    });
    return Object.fromEntries(entries);
}

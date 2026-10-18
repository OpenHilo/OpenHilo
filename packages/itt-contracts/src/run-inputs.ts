import type {Value, ValueType} from './index';
import {parseHumanOutputValue} from './human-output';

/** Absent encoding retains the historical CLI coercion. New forms opt in explicitly. */
export type RunInputEncoding = 'typed-text-v1';
export type RunInputSchema = Record<string, { kind: ValueType }>;

export class RunInputError extends Error {
    constructor(message: string, public readonly field?: string) {
        super(message);
        this.name = 'RunInputError';
    }
}

/** Validate transport before starting a worker; schema validation happens against its snapshot. */
export function validateRunInputWire(raw: unknown, encoding?: unknown): asserts raw is Record<string, string> {
    if (encoding !== undefined && encoding !== 'typed-text-v1') throw new RunInputError('Unsupported run input encoding');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RunInputError('Run inputs must be an object containing string values');
    for (const [field, value] of Object.entries(raw)) {
        if (typeof value !== 'string') throw new RunInputError(`Run input ${field} must be a string`, field);
    }
}

/** Decode exactly once. JSON string values are quoted JSON, not guessed from their contents. */
export function parseRunInputs(raw: unknown, schema: RunInputSchema, encoding?: RunInputEncoding): Record<string, Value> {
    validateRunInputWire(raw, encoding);
    if (encoding === 'typed-text-v1') {
        for (const field of Object.keys(schema)) {
            if (!Object.hasOwn(raw, field)) throw new RunInputError(`Missing run input: ${field}`, field);
        }
    }
    return Object.fromEntries(Object.entries(raw).map(([field, value]) => {
        const kind = Object.hasOwn(schema, field) ? schema[field].kind : undefined;
        if (encoding === undefined) {
            // Existing CLI/schedule/history semantics: JSON/text are not reparsed and
            // legacy boolean '1' remains true. Unknown extra fields remain strings.
            return [field, kind === 'number' ? Number(value) : kind === 'boolean' ? value === 'true' || value === '1' : value];
        }
        if (!kind) throw new RunInputError(`Unknown run input: ${field}`, field);
        try {
            const decoded = parseHumanOutputValue(value, kind, field);
            if (hasNegativeZero(decoded)) throw new Error('Negative zero cannot survive JSON persistence');
            return [field, decoded];
        } catch {
            throw new RunInputError(`Invalid ${kind} run input: ${field}`, field);
        }
    }));
}

function hasNegativeZero(value: Value): boolean {
    if (typeof value === 'number') return Object.is(value, -0);
    return value !== null && typeof value === 'object' && Object.values(value).some(hasNegativeZero);
}

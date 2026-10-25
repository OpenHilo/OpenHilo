import type {Value, ValueType} from './index';
import {parseHumanOutputValue} from './human-output';

/** Absent encoding retains the historical CLI coercion. New forms opt in explicitly. */
export type RunInputEncoding = 'typed-text-v1';
/** Serializable data shape for workflow entry forms, independent of the TypeScript compiler. */
export type InputShape =
    | { type: ValueType | 'null' }
    | { type: 'literal'; value: string | number | boolean | null }
    | { type: 'object'; properties: Record<string, { shape: InputShape; optional?: boolean }>; additional?: InputShape; numericAdditional?: InputShape; numericKeys?: boolean }
    | { type: 'array'; items: InputShape }
    | { type: 'tuple'; items: { shape: InputShape; optional?: boolean; rest?: boolean }[] }
    | { type: 'union'; options: InputShape[] };
export type RunInputDefinition = { kind: ValueType; shape?: InputShape };
export type RunInputSchema = Record<string, RunInputDefinition>;

/** Validate without coercing, dropping fields or inventing values. Errors identify the nested field. */
export function validateInputShape(value: unknown, shape: InputShape, field = 'input'): void {
    const fail = (expected: string): never => { throw new RunInputError(`${field}: ${expected}`, field); };
    switch (shape.type) {
        case 'json': return;
        case 'text': if (typeof value !== 'string') fail('expected text'); return;
        case 'file': case 'dir':
            if (typeof value !== 'string' || !value.trim()) fail(`expected a ${shape.type === 'file' ? 'file' : 'directory'} path`);
            return;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) fail('expected a finite number');
            return;
        case 'boolean': if (typeof value !== 'boolean') fail('expected true or false'); return;
        case 'null': if (value !== null) fail('expected null'); return;
        case 'literal': if (value !== shape.value) fail(`expected ${JSON.stringify(shape.value)}`); return;
        case 'array':
            if (!Array.isArray(value)) return fail('expected a list');
            value.forEach((item, index) => validateInputShape(item, shape.items, `${field}[${index}]`)); return;
        case 'object': {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('expected an object');
            const record = value as Record<string, unknown>;
            for (const [key, property] of Object.entries(shape.properties)) {
                if (!Object.hasOwn(record, key)) {
                    if (!property.optional) throw new RunInputError(`${field}.${key}: required`, `${field}.${key}`);
                } else validateInputShape(record[key], property.shape, `${field}.${key}`);
            }
            // TypeScript is structurally typed: retain extra fields. Validate them only when an index signature declares their type.
            if (shape.additional) for (const [key, item] of Object.entries(record)) {
                if (shape.numericKeys && (key.trim() === '' || !Number.isFinite(Number(key)))) fail(`expected a numeric key, received ${JSON.stringify(key)}`);
                validateInputShape(item, shape.additional, `${field}.${key}`);
            }
            if (shape.numericAdditional) for (const [key, item] of Object.entries(record)) {
                if (key.trim() !== '' && Number.isFinite(Number(key))) validateInputShape(item, shape.numericAdditional, `${field}.${key}`);
            }
            return;
        }
        case 'union': {
            for (const option of shape.options) {
                try { validateInputShape(value, option, field); return; } catch (error) { if (!(error instanceof RunInputError)) throw error; }
            }
            return fail(`expected one of: ${shape.options.map(inputShapeLabel).join(' | ')}`);
        }
        case 'tuple': {
            if (!Array.isArray(value)) return fail('expected a tuple');
            const length = value.length;
            // next[index] describes whether the remaining tuple items match the
            // input suffix. Two rows bound memory and avoid a call per rest value.
            let next = new Uint8Array(length + 1);
            next[length] = 1;
            for (let part = shape.items.length - 1; part >= 0; part--) {
                const item = shape.items[part], current = new Uint8Array(length + 1);
                for (let index = length; index >= 0; index--) {
                    // Optional slots can be omitted at the end of the input;
                    // unlike a rest, they cannot shift an existing value left.
                    if ((item.rest || (item.optional && index === length)) && next[index]) {
                        current[index] = 1;
                        continue;
                    }
                    if (index === length || !(item.rest ? current[index + 1] : next[index + 1])) continue;
                    try {
                        validateInputShape(value[index], item.shape, `${field}[${index}]`);
                        current[index] = 1;
                    } catch (error) {if (!(error instanceof RunInputError)) throw error;}
                }
                next = current;
            }
            if (!next[0]) fail('tuple items do not match their declared types or length');
            return;
        }
    }
}

export function inputShapeLabel(shape: InputShape): string {
    if (shape.type === 'literal') return JSON.stringify(shape.value);
    if (shape.type === 'array') return `${inputShapeLabel(shape.items)}[]`;
    if (shape.type === 'union') return shape.options.map(inputShapeLabel).join(' | ');
    return shape.type;
}

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
            if (schema[field].shape) validateInputShape(decoded, schema[field].shape!, field);
            return [field, decoded];
        } catch (error) {
            if (error instanceof RunInputError) throw error;
            throw new RunInputError(`Invalid ${kind} run input: ${field}`, field);
        }
    }));
}

function hasNegativeZero(value: Value): boolean {
    if (typeof value === 'number') return Object.is(value, -0);
    return value !== null && typeof value === 'object' && Object.values(value).some(hasNegativeZero);
}

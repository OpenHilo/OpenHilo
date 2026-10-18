import {types} from 'node:util';
import {AbortError, type Value} from './types';

const nativeObject = Function.prototype.toString.call(Object);
const nativeArray = Function.prototype.toString.call(Array);

/** Plain data from the host or a Node VM realm; never invoke getters or toJSON. */
export function assertWorkflowValue(value: unknown): asserts value is Value {
    const ancestors = new Set<object>();
    const checked = new Set<object>();

    function invalid(reason: string): never {
        throw new AbortError(`Workflow value is not JSON-compatible: ${reason}`);
    }

    function visit(item: unknown): void {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) invalid('non-finite number');
            if (Object.is(item, -0)) invalid('negative zero');
            return;
        }
        if (typeof item !== 'object') invalid(typeof item);
        if (types.isProxy(item)) invalid('proxy');
        if (types.isBoxedPrimitive(item) || types.isDate(item) || types.isRegExp(item) ||
            types.isMap(item) || types.isSet(item) || types.isWeakMap(item) || types.isWeakSet(item) ||
            types.isPromise(item) || types.isAnyArrayBuffer(item) || types.isArrayBufferView(item))
            invalid('non-plain object');
        if (ancestors.has(item)) invalid('cycle');
        if (checked.has(item)) return;
        if (!Object.isExtensible(item)) invalid('nonextensible, frozen or sealed object');
        const array = Array.isArray(item);
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== null) {
            if (types.isProxy(prototype)) invalid('proxy prototype');
            const expectedPrototype = array ? Array.prototype : Object.prototype;
            const prototypeKeys = Object.getOwnPropertyNames(prototype);
            const expectedKeys = Object.getOwnPropertyNames(expectedPrototype);
            if (prototypeKeys.length !== expectedKeys.length || prototypeKeys.some(key => !expectedKeys.includes(key)))
                invalid('non-plain prototype');
            const objectPrototype = array ? Object.getPrototypeOf(prototype) : prototype;
            if (!objectPrototype || types.isProxy(objectPrototype) || Object.getPrototypeOf(objectPrototype) !== null ||
                Object.getOwnPropertyDescriptor(objectPrototype, 'toJSON')) invalid('non-plain prototype');
            const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
            if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function' || constructor.value.prototype !== prototype ||
                Function.prototype.toString.call(constructor.value) !== (array ? nativeArray : nativeObject))
                invalid('non-plain object');
        } else invalid('null prototype');
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Reflect.ownKeys(descriptors);
        if (array && keys.length !== item.length + 1) invalid('sparse array or extra array properties');
        ancestors.add(item);
        try {
            for (const key of keys) {
                if (typeof key !== 'string') invalid('symbol key');
                if (array && key === 'length') {
                    if (!descriptors[key].writable) invalid('readonly array length');
                    continue;
                }
                if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) invalid('extra array property');
                const descriptor = descriptors[key];
                if (!descriptor.enumerable || !('value' in descriptor)) invalid('accessor or hidden property');
                if (!descriptor.writable || !descriptor.configurable) invalid('nonordinary data descriptor');
                visit(descriptor.value);
            }
        } finally {
            ancestors.delete(item);
        }
        checked.add(item);
    }

    try {
        visit(value);
    } catch (error) {
        if (error instanceof AbortError) throw error;
        throw new AbortError('Workflow value could not be inspected as JSON data');
    }
}

export function copyWorkflowValue<T>(value: T): T {
    assertWorkflowValue(value);
    return createStateCopier()(value);
}

/** Preserve every own JSON key, including __proto__, without invoking a setter. */
export function setValueField(map: Record<string, Value>, key: string, value: Value): void {
    Object.defineProperty(map, key, {value, enumerable: true, writable: true, configurable: true});
}

/** Adopt ordinary VM data without duplicating any object or invoking accessors. */
export function adoptWorkflowValue<T>(value: T): T {
    assertWorkflowValue(value);
    const visited = new Set<object>();

    function adopt(item: unknown): void {
        if (item === null || typeof item !== 'object' || visited.has(item)) return;
        visited.add(item);
        const prototype = Array.isArray(item) ? Array.prototype : Object.prototype;
        if (Object.getPrototypeOf(item) !== prototype) Object.setPrototypeOf(item, prototype);
        for (const child of Object.values(item)) adopt(child);
    }

    adopt(value);
    return value;
}

/** Internal copier also accepts optional undefined metadata. Validate workflow values first. */
export function createStateCopier(): <T>(value: T) => T {
    const copies = new WeakMap<object, object>();

    function copy<T>(value: T): T {
        if (value === null || typeof value !== 'object') return value;
        if (copies.has(value)) return copies.get(value) as T;
        const result: any = Array.isArray(value) ? [] : {};
        copies.set(value, result);
        for (const [key, child] of Object.entries(value)) setValueField(result, key, copy(child) as Value);
        return result;
    }

    return copy;
}

/** Exact workflow result envelope; preserve its identity after checking data. */
export function assertReturnValue(value: unknown, keys: readonly string[]): Record<string, Value> {
    assertWorkflowValue(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new AbortError('Workflow return must be an object with the declared output fields');
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
        throw new AbortError('Workflow return fields must exactly match the declared output fields');
    return value as Record<string, Value>;
}

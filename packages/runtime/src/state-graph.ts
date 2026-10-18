/** Whole-state graph transport. Lookup tables live only for one copy/save/restore. */
import {AbortError, type CheckpointFrame, type GraphNode, type GraphValue, type StateGraph, type Value} from './types';
import {assertWorkflowValue, setValueField} from './workflow-value';

export function encodeStateGraph(value: Value): StateGraph {
    assertWorkflowValue(value);
    const ids = new Map<object, number>();
    const nodes: GraphNode[] = [];

    function visit(item: Value): GraphValue {
        if (item === null || typeof item !== 'object') return item;
        const previous = ids.get(item);
        if (previous !== undefined) return {ref: previous};
        const ref = nodes.length;
        ids.set(item, ref);
        const node: GraphNode = Array.isArray(item) ? {kind: 'array', items: []} : {kind: 'object', entries: []};
        nodes.push(node);
        if (node.kind === 'array') node.items = (item as Value[]).map(visit);
        else node.entries = Object.entries(item).map(([key, child]) => [key, visit(child)]);
        return {ref};
    }

    const root = visit(value);
    return {format: 'openhilo-state-graph', version: 1, root, nodes};
}

export function decodeStateGraph(graph: unknown): Value {
    function invalid(reason: string): never {
        throw new AbortError(`Invalid state graph: ${reason}`);
    }

    function record(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    if (!record(graph) || graph.format !== 'openhilo-state-graph' || graph.version !== 1 || !Array.isArray(graph.nodes))
        invalid('unsupported format or version');
    const nodes = graph.nodes;
    const values: Value[] = nodes.map(node => {
        if (!record(node)) invalid('invalid node');
        if (node.kind === 'array' && Array.isArray(node.items) && Object.keys(node).length === 2) return [];
        if (node.kind === 'object' && Array.isArray(node.entries) && Object.keys(node).length === 2) return {};
        return invalid('invalid node shape');
    });

    function resolve(token: unknown): Value {
        if (token === null || typeof token === 'string' || typeof token === 'boolean') return token;
        if (typeof token === 'number' && Number.isFinite(token) && !Object.is(token, -0)) return token;
        if (!record(token) || Object.keys(token).length !== 1 || !Number.isSafeInteger(token.ref) ||
            (token.ref as number) < 0 || (token.ref as number) >= values.length) invalid('invalid reference or value');
        return values[token.ref as number];
    }

    nodes.forEach((node, index) => {
        if (node.kind === 'array') {
            for (const token of node.items) (values[index] as Value[]).push(resolve(token));
        } else {
            const keys = new Set<string>();
            for (const entry of node.entries) {
                if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0]))
                    invalid('invalid or duplicate object entry');
                keys.add(entry[0]);
                setValueField(values[index] as Record<string, Value>, entry[0], resolve(entry[1]));
            }
        }
    });
    const result = resolve(graph.root);
    assertWorkflowValue(result); // Reject cycles and unsupported data before any execution.
    return result;
}

/** JSONL consumers must decode a whole call_stack, never one frame at a time. */
export function decodeCheckpointStack(value: unknown): CheckpointFrame[] {
    const stack = Array.isArray(value) ? value : decodeStateGraph(value);
    assertWorkflowValue(stack);
    if (!Array.isArray(stack)) throw new AbortError('Invalid checkpoint call stack: expected frame array');
    return stack as unknown as CheckpointFrame[];
}

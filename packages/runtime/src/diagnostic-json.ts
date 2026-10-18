/** Keep diagnostic JSON bounded when a small shared DAG would expand into a huge tree. */
import type {GraphValue, Value} from './types';
import {encodeStateGraph} from './state-graph';

export function diagnosticJson(value: Value, inlineLimit: number): { text: string; graph: boolean } {
    const graph = encodeStateGraph(value);
    const sizes = new Map<number, number>();
    const cap = inlineLimit + 1;
    const bytes = (value: string) => Buffer.byteLength(JSON.stringify(value), 'utf8');

    function size(token: GraphValue): number {
        if (token === null || typeof token !== 'object') return Buffer.byteLength(JSON.stringify(token), 'utf8');
        const known = sizes.get(token.ref);
        if (known !== undefined) return known;
        const node = graph.nodes[token.ref];
        let total = 2;
        if (node.kind === 'array') {
            for (const child of node.items) {
                total += size(child) + 1;
                if (total > cap) break;
            }
            if (node.items.length) total--;
        } else {
            for (const [key, child] of node.entries) {
                total += bytes(key) + 1 + size(child) + 1;
                if (total > cap) break;
            }
            if (node.entries.length) total--;
        }
        total = Math.min(total, cap);
        sizes.set(token.ref, total);
        return total;
    }

    let references = typeof graph.root === 'object' && graph.root !== null ? 1 : 0;
    for (const node of graph.nodes) {
        const children = node.kind === 'array' ? node.items : node.entries.map(([, child]) => child);
        for (const child of children) if (typeof child === 'object' && child !== null) references++;
    }
    if (references > graph.nodes.length && size(graph.root) > inlineLimit) {
        return {text: JSON.stringify(graph), graph: true};
    }
    return {text: JSON.stringify(value), graph: false};
}

// src/translator/node-id-gen.ts

type NodeKind = 'assign' | 'if' | 'for' | 'foreach' | string; // string for call_<callee>

export class NodeIdGen {
    private counters = new Map<string, number>();

    next(kind: NodeKind): string {
        const n = (this.counters.get(kind) ?? 0) + 1;
        this.counters.set(kind, n);
        return `${kind}_${n}`;
    }

    // call nodes use 'call_<callee>' as their kind
    nextCall(callee: string): string {
        return this.next(`call_${callee}`);
    }
}

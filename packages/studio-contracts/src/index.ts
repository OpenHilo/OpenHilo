/** JSON-only application presentation. No components, executable code, or CSS supplied by apps. */
export type StudioTone = 'neutral' | 'indigo' | 'cyan' | 'green' | 'emerald' | 'orange' | 'purple' | 'sky' | 'yellow';

export interface StudioApplication {
    version: 1;
    id: string;
    title: string;
    classFacet?: {
        tag: string;
        values: Array<{ value: string; label: string; description?: string; tone?: StudioTone }>;
    };
    /** Omitted: show all schema-defined class filters. Empty: show none. */
    classFilterTags?: string[];
    /** Optional scalar workflow metadata field and its display choices. */
    workflowFacet?: { field: string; label: string; values: Array<{ value: string; label: string }> };
    workflowFilterTags?: string[];
    tags: Record<string, { tone?: StudioTone; inlineEditable?: boolean }>;
}

export const GENERIC_STUDIO_APPLICATION: StudioApplication = {
    version: 1, id: 'generic', title: 'OpenHilo', tags: {},
};

/** Validate the wire boundary, then copy so callers cannot mutate the supplied configuration. */
export function parseStudioApplication(value: unknown): StudioApplication {
    const fail = (): never => {
        throw new Error('Invalid Studio application descriptor');
    };
    const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const only = (v: Record<string, unknown>, ...keys: string[]) => Object.keys(v).every(key => keys.includes(key));
    const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    const tone = (v: unknown) => v === undefined || ['neutral', 'indigo', 'cyan', 'green', 'emerald', 'orange', 'purple', 'sky', 'yellow'].includes(v as string);
    if (!object(value) || value.version !== 1 || !string(value.id) || !string(value.title) || !object(value.tags)) return fail();
    if (!only(value, 'version', 'id', 'title', 'classFacet', 'classFilterTags', 'workflowFacet', 'workflowFilterTags', 'tags')) return fail();
    for (const presentation of Object.values(value.tags)) {
        if (!object(presentation) || !only(presentation, 'tone', 'inlineEditable') || !tone(presentation.tone) || (presentation.inlineEditable !== undefined && typeof presentation.inlineEditable !== 'boolean')) return fail();
    }
    if (value.classFilterTags !== undefined && (!Array.isArray(value.classFilterTags) || !value.classFilterTags.every(string))) return fail();
    if (value.classFacet !== undefined) {
        const facet = value.classFacet;
        if (!object(facet) || !only(facet, 'tag', 'values') || !string(facet.tag) || !Array.isArray(facet.values)) return fail();
        const seen = new Set<string>();
        for (const entry of facet.values) {
            if (!object(entry) || !only(entry, 'value', 'label', 'description', 'tone') || !string(entry.value) || !string(entry.label) || !tone(entry.tone) || (entry.description !== undefined && !string(entry.description)) || seen.has(entry.value)) return fail();
            seen.add(entry.value);
        }
    }
    if (value.workflowFilterTags !== undefined && (!Array.isArray(value.workflowFilterTags) || !value.workflowFilterTags.every(string))) return fail();
    if (value.workflowFacet !== undefined) {
        const facet = value.workflowFacet;
        if (!object(facet) || !only(facet, 'field', 'label', 'values') || !string(facet.field) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(facet.field) || ['__proto__', 'constructor', 'prototype'].includes(facet.field) || !string(facet.label) || !Array.isArray(facet.values)) return fail();
        const seen = new Set<string>();
        for (const entry of facet.values) {
            if (!object(entry) || !only(entry, 'value', 'label') || !string(entry.value) || !string(entry.label) || seen.has(entry.value)) return fail();
            seen.add(entry.value);
        }
    }
    try {
        return JSON.parse(JSON.stringify(value)) as StudioApplication;
    } catch {
        return fail();
    }
}

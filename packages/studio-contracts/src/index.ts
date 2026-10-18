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
    const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    const tone = (v: unknown) => v === undefined || ['neutral', 'indigo', 'cyan', 'green', 'emerald', 'orange', 'purple', 'sky', 'yellow'].includes(v as string);
    if (!object(value) || value.version !== 1 || !string(value.id) || !string(value.title) || !object(value.tags)) return fail();
    for (const presentation of Object.values(value.tags)) {
        if (!object(presentation) || !tone(presentation.tone) || (presentation.inlineEditable !== undefined && typeof presentation.inlineEditable !== 'boolean')) return fail();
    }
    if (value.classFilterTags !== undefined && (!Array.isArray(value.classFilterTags) || !value.classFilterTags.every(string))) return fail();
    if (value.classFacet !== undefined) {
        const facet = value.classFacet;
        if (!object(facet) || !string(facet.tag) || !Array.isArray(facet.values)) return fail();
        const seen = new Set<string>();
        for (const entry of facet.values) {
            if (!object(entry) || !string(entry.value) || !string(entry.label) || !tone(entry.tone) || (entry.description !== undefined && !string(entry.description)) || seen.has(entry.value)) return fail();
            seen.add(entry.value);
        }
    }
    return JSON.parse(JSON.stringify(value)) as StudioApplication;
}

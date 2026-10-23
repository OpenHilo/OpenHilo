import {outputFields, typeToValueType} from './type-contract';
import {directCallee} from './expression-forms';
// src/translator/multi-intent-compiler.ts
import * as ts from 'typescript';
import type {CFGITT, LeafITT, ValueType} from '@openhilo/itt-contracts';
import type {FunctionSignature, SourceSpan} from './ast-to-itt';
import {compileFunctionBody} from './ast-to-itt';
import type {CallDeclaration, SystemMethodRegistry} from './ts-validator';
import {validateTranslatorTs} from './ts-validator';
import {buildImportMap} from './import-resolver';

/** Extract text value of a JSDoc tag from a function node. */
export function getJsDocTag(node: ts.Node, sf: ts.SourceFile, tagName: string): string | null {
    const fullText = sf.text;
    const nodeStart = node.getFullStart();
    const nodePos = node.getStart(sf);
    const leading = fullText.slice(nodeStart, nodePos);
    // Match /** ... */ blocks
    const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
    let match: RegExpExecArray | null;
    let lastJsdoc: string | null = null;
    while ((match = jsdocRegex.exec(leading)) !== null) {
        lastJsdoc = match[1];
    }
    if (!lastJsdoc) return null;
    const tagRegex = new RegExp(`@${tagName}\\s+([^\\s@*]+)`);
    const tagMatch = tagRegex.exec(lastJsdoc);
    return tagMatch ? tagMatch[1].trim() : null;
}

/** Returns true if @entry tag is present. */
export function getEntryTag(node: ts.Node, sf: ts.SourceFile): boolean {
    const fullText = sf.text;
    const nodeStart = node.getFullStart();
    const nodePos = node.getStart(sf);
    const leading = fullText.slice(nodeStart, nodePos);
    return /@entry\b/.test(leading);
}

export interface MultiIntentResult {
    intents: Array<{
        name: string;
        declaration: LeafITT;    // .itt.json — intent 接口声明（executor: 'intent'）
        sourceMap: Record<string, SourceSpan>;
        implementation: CFGITT;  // .itt.impl.json — 完整 CFG 实现
    }>;
    /** Intent names marked with @entry — the top-level callable intents. */
    entries: string[];
}

/** Returns true if the TS source contains any async function definitions. */
export function isMultiFunctionTs(source: string): boolean {
    const sf = ts.createSourceFile('check.ts', source, ts.ScriptTarget.Latest, true);
    for (const stmt of sf.statements) {
        if (
            ts.isFunctionDeclaration(stmt) &&
            stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)
        ) return true;
    }
    return false;
}

/** Pass 1: collect all async function definitions into a registry with full signatures. */
export function buildFunctionRegistry(source: string): Map<string, FunctionSignature> {
    const sf = ts.createSourceFile('reg.ts', source, ts.ScriptTarget.Latest, true);
    const registry = new Map<string, FunctionSignature>();

    for (const stmt of sf.statements) {
        if (!ts.isFunctionDeclaration(stmt)) continue;
        if (!stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
        const name = stmt.name?.text;
        if (!name) continue;

        // Populate params from the function's parameter list
        const params: { name: string; kind: ValueType }[] = (stmt.parameters ?? []).map(p => ({
            name: (p.name as ts.Identifier).text,
            kind: typeToValueType(p.type),
        }));

        const outputs = outputFields(stmt.type);

        const isPublic = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        if (registry.has(name)) throw new Error(`Duplicate function declaration: ${name}`);
        registry.set(name, {params, outputs, node: stmt, isPublic});
    }

    return registry;
}

/**
 * Circular call detection via DFS (file-scoped only).
 * @param callGraph  Map<functionName, list of called function names in registry>
 */
export function checkCircularCalls(callGraph: Map<string, string[]>): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const name of callGraph.keys()) color.set(name, WHITE);

    function dfs(node: string, path: string[]): void {
        color.set(node, GRAY);
        for (const neighbour of callGraph.get(node) ?? []) {
            if (!callGraph.has(neighbour)) continue; // cross-file call — skip
            if (color.get(neighbour) === GRAY) {
                throw new Error(
                    `Circular intent call detected: ${[...path, node, neighbour].join(' → ')}`,
                );
            }
            if (color.get(neighbour) === WHITE) dfs(neighbour, [...path, node]);
        }
        color.set(node, BLACK);
    }

    for (const name of callGraph.keys()) {
        if (color.get(name) === WHITE) dfs(name, []);
    }
}

export function compileMultiIntent(
    source: string,
    nsPath: string = '',
    extraDeclarations: CallDeclaration[] = [],
    options: { systemMethods?: SystemMethodRegistry; importMap?: Map<string, string> } = {},
): MultiIntentResult {
    // Preserve source offsets; optional skills are handled by declaration extraction.

    // 1. Validate and collect executor-suffix declarations from source
    const validation = validateTranslatorTs(source, options.systemMethods);
    if (!validation.ok) throw new Error(`Validation errors:\n${validation.errors.join('\n')}`);
    const {declarations, sourceFile} = validation;

    // 1a. Build import map for callee resolution (localName → qualifiedCallee)
    const importMap = options.importMap ?? buildImportMap(source, nsPath);

    // 1b. Merge validator declarations with extra (from imported Brain files)
    const allDeclarations = [...declarations, ...extraDeclarations];

    // 2. Build function registry (pass 1) — only async functions in source
    const registry = buildFunctionRegistry(source);

    // Re-attach the SourceFile nodes from the validated sourceFile
    for (const stmt of sourceFile.statements) {
        if (
            ts.isFunctionDeclaration(stmt) &&
            stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) &&
            stmt.name
        ) {
            const entry = registry.get(stmt.name.text);
            if (entry) entry.node = stmt;
        }
    }

    // 3. Build call graph for circular detection (same-file functions only)
    const callGraph = new Map<string, string[]>();
    for (const [name, sig] of registry) {
        const called: string[] = [];

        function walkForCalls(node: ts.Node): void {
            if (ts.isCallExpression(node)) {
                const callee = directCallee(node);
                if (callee && registry.has(callee.text)) {
                    called.push(callee.text);
                }
            }
            ts.forEachChild(node, walkForCalls);
        }

        if (sig.node.body) walkForCalls(sig.node.body);
        callGraph.set(name, called);
    }
    checkCircularCalls(callGraph);

    // 4. Pass 2: compile each async function
    const intents: MultiIntentResult['intents'] = [];
    const entries: string[] = [];
    for (const [name, sig] of registry) {
        const compiled = compileFunctionBody(
            sig.node, sourceFile, allDeclarations, registry, sig.outputs, nsPath, importMap,
        );

        const inputsSchema = Object.fromEntries(compiled.inputs.map(input => [input.name, {kind: input.kind, shape: input.shape}]));
        const declOutputsSchema = Object.fromEntries(compiled.outputs.map(output => [output.name, output.kind]));
        const implOutputsSchema = Object.fromEntries(compiled.outputs.map(output => [output.name, output.name]));

        // Extract @tags JSDoc annotation
        let intentTags: Record<string, string> | undefined;
        const jsdocTags = ts.getJSDocTags(sig.node);
        const tagsAnnotation = jsdocTags.find(t => t.tagName.text === 'tags');
        if (tagsAnnotation && typeof tagsAnnotation.comment === 'string') {
            try {
                intentTags = JSON.parse(tagsAnnotation.comment) as Record<string, string>;
                if (!intentTags || typeof intentTags !== 'object' || Array.isArray(intentTags) || Object.values(intentTags).some(value => typeof value !== 'string'))
                    throw new Error('Tags must be an object of string values');
            } catch {
                throw new Error(`Invalid @tags JSON on function '${name}'`);
            }
        }

        // Entry selection is independent of indexing metadata.
        const isEntry = getEntryTag(sig.node, sourceFile);
        if (isEntry) entries.push(name);

        // Public module exports are independent of domain tags.
        const isPublicIntent = sig.isPublic;

        const declaration: LeafITT = {
            version: 2,
            name,
            ...(nsPath ? {namespace: nsPath} : {}),
            ...(intentTags !== undefined ? {tags: intentTags} : {}),
            ...(!isPublicIntent ? {public: false} : {}),
            executor: 'intent',
            inputs: inputsSchema,
            outputs: declOutputsSchema,
            nodes: {},
            entry: name,
        };

        const implementation: CFGITT = {
            version: 2,
            name,
            ...(nsPath ? {namespace: nsPath} : {}),
            ...(!isPublicIntent ? {public: false} : {}),
            entry: compiled.entry,
            nodes: compiled.nodes,
            inputs: inputsSchema,
            outputs: implOutputsSchema,
            resultVar: compiled.resultVar,
            expressionSemantics: 'plain-data',
        };

        intents.push({name, declaration, implementation, sourceMap: compiled.sourceMap});
    }

    return {intents, entries};
}

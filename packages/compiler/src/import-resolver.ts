// src/translator/import-resolver.ts
import * as ts from 'typescript';

/**
 * Resolve a relative TS import path to a fully-qualified Brain callee name.
 *
 * nsPath is the dot-notation namespace of the file containing the import.
 * The last path segment of importPath is treated as the intent (function) name.
 *
 * Examples (nsPath = 'businessIntel'):
 *   './summarize_by_ai'   → 'businessIntel.summarize_by_ai'
 *   '../utils/formatText' → 'utils.formatText'
 *   '../../a/b/fn'        → 'a.b.fn'  (from nsPath 'x.y')
 */
export function resolveImportPath(importPath: string, nsPath: string): string {
    const nsParts = nsPath ? nsPath.split('.') : [];
    const importParts = importPath.split('/');
    const resolved = [...nsParts];
    for (const part of importParts) {
        if (part === '..') {
            if (!resolved.length) throw new Error('Import escapes the namespace root');
            resolved.pop();
        } else if (part !== '.') {
            resolved.push(part);
        }
    }
    return resolved.join('.');
}

/**
 * Parse all named ES module imports from TS source and return a map:
 * localName → qualified Brain callee (dot-notation).
 *
 * This compatibility resolver assumes one workflow per file, matching its basename.
 * Use compileProgram for modules containing multiple exports.
 * Aliased imports (`import { a as b }`) use the alias as the map key.
 */
export function buildImportMap(source: string, nsPath: string): Map<string, string> {
    const importMap = new Map<string, string>();
    const sf = ts.createSourceFile('src.ts', source, ts.ScriptTarget.Latest, true);

    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        const modulePath = (stmt.moduleSpecifier as ts.StringLiteral).text;
        const clause = stmt.importClause;
        if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;

        const qualifiedCallee = resolveImportPath(modulePath.replace(/\.ts$/, ''), nsPath);
        for (const element of clause.namedBindings.elements) {
            const exported = (element.propertyName ?? element.name).text;
            if (exported !== qualifiedCallee.split('.').at(-1))
                throw new Error(`Legacy import ${exported} must match its workflow filename; use compileProgram for multi-export modules`);
            importMap.set(element.name.text, qualifiedCallee);
        }
    }

    return importMap;
}

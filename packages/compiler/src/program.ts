import { expandModuleTypes } from './module-types';
import {directCallee} from './expression-forms';
import * as ts from 'typescript';
import {posix as path} from 'path';
import {type CFGITT, IttValidator, type LeafITT} from '@openhilo/itt-contracts';
import {buildFunctionRegistry, checkCircularCalls, compileMultiIntent} from './multi-intent-compiler';
import {type CallDeclaration, type SystemMethodRegistry, validateTranslatorTs} from './ts-validator';
import type {FunctionSignature, SourceSpan} from './ast-to-itt';

export interface ProgramInput {
    /** Relative POSIX .ts paths and source contents. No filesystem or network resolution occurs. */
    files: Record<string, string>;
    entries: Array<{ file: string; exportName: string }>;
    systemMethods?: SystemMethodRegistry;
}

export interface CompileDiagnostic {
    code: 'invalid_input' | 'invalid_source' | 'invalid_import' | 'invalid_entry' | 'recursive_call' | 'compile_error';
    message: string;
    file?: string;
    line?: number;
    column?: number;
}

export interface CompiledArtifact {
    id: string;
    file: string;
    exportName: string;
    declaration: LeafITT;
    implementation: CFGITT;
    sourceMap: Record<string, SourceSpan>;
}

export interface ProgramResult {
    ok: boolean;
    artifacts: CompiledArtifact[];
    entries: string[];
    dependencies: Array<{ from: string; to: string }>;
    diagnostics: CompileDiagnostic[];
}

type Module = {
    file: string;
    namespace: string;
    source: string;
    sf: ts.SourceFile;
    registry: Map<string, FunctionSignature>;
    imports: Map<string, string>;
    declarations: CallDeclaration[]
};

function virtualPath(file: string): string {
    if (typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0') || path.isAbsolute(file)) throw new Error('Source paths must be relative POSIX paths');
    const normalized = path.normalize(file);
    if (normalized.startsWith('../') || !normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) throw new Error('Source paths must stay within the virtual root and name .ts files');
    // Namespace conversion must be injective; dots in directory/file stems would alias path separators.
    if (normalized.slice(0, -3).split('/').some(part => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part))) throw new Error('Source path segments must be identifier-like names without dots');
    return normalized;
}

/** Compile a closed virtual module graph. Failures never return partial executable artifacts. */
export function compileProgram(input: ProgramInput): ProgramResult {
    let expanded: ReturnType<typeof expandModuleTypes> | undefined;
    const diagnostics: CompileDiagnostic[] = [];
    const dependencies: ProgramResult['dependencies'] = [];
    const modules = new Map<string, Module>();
    const fail = (code: CompileDiagnostic['code'], message: string, file?: string, node?: ts.Node, sf?: ts.SourceFile) => {
        const embedded = /^(\d+):(\d+)\s+(.*)$/s.exec(message);
        const position = node && sf ? sf.getLineAndCharacterOfPosition(node.getStart(sf)) : embedded ? {
            line: Number(embedded[1]) - 1,
            character: Number(embedded[2]) - 1
        } : undefined;
        if (embedded) message = embedded[3];
        diagnostics.push({
            code, message, ...(file ? {file} : {}), ...(position ? (file && expanded ? expanded.position(file, position.line + 1, position.character + 1) : {
                line: position.line + 1,
                column: position.character + 1
            }) : {})
        });
    };
    const failed = (): ProgramResult => ({ok: false, artifacts: [], entries: [], dependencies, diagnostics});
    if (!input || !input.files || typeof input.files !== 'object' || Array.isArray(input.files) || !Array.isArray(input.entries) || !input.entries.length) {
        fail('invalid_input', 'Provide virtual source files and at least one explicit entry');
        return failed();
    }
    try {
        const normalized: Record<string, string> = {};
        for (const [name, source] of Object.entries(input.files)) {
            const file = virtualPath(name);
            if (Object.hasOwn(normalized, file)) throw new Error('Duplicate normalized source path');
            if (typeof source !== 'string') throw new Error('Source content must be a string');
            normalized[file] = source;
        }
        expanded = expandModuleTypes(normalized);
        dependencies.push(...expanded.dependencies);
    } catch (error) { fail('invalid_source', (error as Error).message); return failed(); }
    for (const [rawPath, source] of Object.entries(expanded.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        try {
            const file = virtualPath(rawPath);
            if (modules.has(file)) throw new Error('Duplicate normalized source path');
            if (typeof source !== 'string') throw new Error('Source content must be a string');
            const validation = validateTranslatorTs(source, input.systemMethods);
            if (!validation.ok) {
                validation.errors.forEach(message => fail('invalid_source', message, file));
                continue;
            }
            const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
            // Module mode has declarations only: otherwise compileMultiIntent would discard top-level effects.
            for (const statement of sf.statements) {
                if (!ts.isFunctionDeclaration(statement) && !ts.isImportDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEmptyStatement(statement))
                    fail('invalid_source', 'Module mode does not execute top-level statements; place workflow steps in an async function', file, statement, sf);
            }
            modules.set(file, {
                file, namespace: file.slice(0, -3).replaceAll('/', '.'), source, sf,
                registry: buildFunctionRegistry(source), imports: new Map(), declarations: []
            });
        } catch (error) {
            fail('invalid_source', (error as Error).message, rawPath);
        }
    }
    if (diagnostics.length) return failed();

    for (const module of modules.values()) {
        for (const statement of module.sf.statements) {
            if (!ts.isImportDeclaration(statement)) continue;
            try {
                if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings) || statement.importClause.isTypeOnly)
                    throw new Error('Only named value imports are supported');
                const specifier = statement.moduleSpecifier.text;
                const base = path.join(path.dirname(module.file), specifier);
                const candidates = base.endsWith('.ts') ? [base] : [`${base}.ts`, `${base}/index.ts`];
                const resolved = candidates.map(virtualPath).find(candidate => modules.has(candidate));
                if (!resolved) throw new Error(`Imported virtual module is missing: ${specifier}`);
                const target = modules.get(resolved)!;
                for (const binding of statement.importClause.namedBindings.elements) {
                    if (binding.isTypeOnly) throw new Error('Type-only imports are unsupported');
                    const exportedName = (binding.propertyName ?? binding.name).text;
                    const signature = target.registry.get(exportedName);
                    if (!signature?.isPublic) throw new Error(`Module ${resolved} does not export workflow ${exportedName}`);
                    const local = binding.name.text;
                    if (module.imports.has(local) || module.registry.has(local)) throw new Error(`Duplicate local callable name: ${local}`);
                    const id = `${target.namespace}.${exportedName}`;
                    module.imports.set(local, id);
                    module.declarations.push({
                        fnName: local, executor: 'intent', callee: id, prefixCount: 0,
                        prefixParams: {role: '', prompt: ''}, inputs: signature.params, outputs: signature.outputs
                    });
                }
                if (!dependencies.some(edge => edge.from === module.file && edge.to === resolved)) dependencies.push({
                    from: module.file,
                    to: resolved
                });
            } catch (error) {
                fail('invalid_import', (error as Error).message, module.file, statement, module.sf);
            }
        }
    }
    if (diagnostics.length) return failed();

    const graph = new Map<string, string[]>();
    for (const module of modules.values()) for (const [name, signature] of module.registry) {
        const targets: string[] = [];
        const walk = (node: ts.Node) => {
            if (ts.isCallExpression(node) && directCallee(node)) {
                const local = directCallee(node)!.text;
                const target = module.imports.get(local) ?? (module.registry.has(local) ? `${module.namespace}.${local}` : undefined);
                if (target) targets.push(target);
            }
            ts.forEachChild(node, walk);
        };
        if (signature.node.body) walk(signature.node.body);
        graph.set(`${module.namespace}.${name}`, targets);
    }
    try {
        checkCircularCalls(graph);
    } catch (error) {
        fail('recursive_call', (error as Error).message);
    }

    const entries: string[] = [];
    for (const entry of input.entries) {
        try {
            const module = modules.get(virtualPath(entry.file));
            if (!module?.registry.get(entry.exportName)?.isPublic) throw new Error('Entry must name an exported async function in a supplied module');
            const id = `${module.namespace}.${entry.exportName}`;
            if (!entries.includes(id)) entries.push(id);
        } catch (error) {
            fail('invalid_entry', (error as Error).message, entry?.file);
        }
    }
    if (diagnostics.length) return failed();

    const artifacts: CompiledArtifact[] = [];
    for (const module of modules.values()) {
        try {
            const compiled = compileMultiIntent(module.source, module.namespace, module.declarations,
                {systemMethods: input.systemMethods, importMap: module.imports});
            for (const intent of compiled.intents) {
                const validation = new IttValidator().validate(intent.implementation);
                if (validation.errors.length) throw new Error(validation.errors.join('\n'));
                artifacts.push({
                    id: `${module.namespace}.${intent.name}`,
                    file: module.file,
                    exportName: intent.name,
                    declaration: intent.declaration,
                    implementation: intent.implementation,
                    sourceMap: expanded.remap(module.file, intent.sourceMap)
                });
            }
        } catch (error) {
            fail('compile_error', (error as Error).message, module.file);
        }
    }
    return diagnostics.length ? failed() : {ok: true, artifacts, entries, dependencies, diagnostics};
}

import * as ts from 'typescript';
import { posix as path } from 'path';
import type { SourceSpan } from './ast-to-itt';
import { typeToValueType } from './type-contract';

type Edit = { start: number; end: number; text: string };
type Alias = { file: string; node: ts.TypeAliasDeclaration };

export class ModuleTypeError extends Error {
    constructor(message: string, readonly file?: string, readonly line?: number, readonly column?: number) { super(message); }
}

const EXPANSION_WORK_LIMIT = 20000;
const EXPANSION_DEPTH_LIMIT = 64;
const EXPANSION_TEXT_LIMIT = 200000;
const PROGRAM_EXPANSION_LIMIT = 5000000;

/** Pure, bounded expansion of JSON type aliases; no disk, package or runtime resolution. */
export function expandModuleTypes(files: Record<string, string>) {
    const parsed = new Map(Object.entries(files).map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]));
    const aliases = new Map<string, Map<string, Alias>>();
    const dependencies: Array<{from: string; to: string}> = [];
    const edits = new Map<string, Edit[]>();
    const exported = (node: ts.TypeAliasDeclaration) => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    const nominal = new Set(['FilePath', 'DirPath']);
    const fail = (file: string, node: ts.Node, message: string, offset?: number): never => {
        const sf = parsed.get(file)!;
        const p = sf.getLineAndCharacterOfPosition(offset ?? node.getStart(sf));
        throw new ModuleTypeError(message, file, p.line + 1, p.character + 1);
    };
    for (const [file, sf] of parsed) {
        const names = new Map<string, Alias>(); aliases.set(file, names); edits.set(file, []);
        for (const node of sf.statements) if (ts.isTypeAliasDeclaration(node) && !nominal.has(node.name.text)) {
            if (['Promise', 'Array', 'ReadonlyArray', 'Record'].includes(node.name.text)) fail(file, node.name, `Reserved type name: ${node.name.text}`);
            if (node.typeParameters?.length) fail(file, node.name, `Generic type aliases are unsupported: ${node.name.text}`);
            if (names.has(node.name.text)) fail(file, node.name, `Duplicate type alias: ${node.name.text}`);
            names.set(node.name.text, {file, node});
            edits.get(file)!.push({start: node.getStart(sf), end: node.end, text: ''});
        }
    }
    for (const [file, sf] of parsed) for (const node of sf.statements) {
        if (!ts.isImportDeclaration(node) || !node.importClause || !node.importClause.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) continue;
        const bindings = node.importClause.namedBindings.elements;
        const types = bindings.filter(b => node.importClause!.isTypeOnly || b.isTypeOnly);
        if (!types.length) continue;
        if (!ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith('.')) fail(file, node.moduleSpecifier, 'Type imports must reference supplied relative modules');
        const base = path.normalize(path.join(path.dirname(file), (node.moduleSpecifier as ts.StringLiteral).text));
        const target = (base.endsWith('.ts') ? [base] : [base + '.ts', base + '/index.ts']).find(p => parsed.has(p));
        if (!target) return fail(file, node.moduleSpecifier, `Missing type module: ${base}`);
        if (!dependencies.some(edge => edge.from === file && edge.to === target)) dependencies.push({from: file, to: target});
        for (const binding of types) {
            const name = (binding.propertyName ?? binding.name).text;
            const declaration = parsed.get(target)!.statements.find(n => ts.isTypeAliasDeclaration(n) && n.name.text === name);
            if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !exported(declaration)) return fail(file, binding, `Module ${target} does not export a supported JSON type alias ${name}`);
            if (nominal.has(name)) {
                if (binding.name.text !== name || declaration.type.kind !== ts.SyntaxKind.StringKeyword)
                    fail(file, binding, 'Path marker imports must retain their name and string declaration');
                continue; // Preserve nominal path semantics instead of expanding to plain string.
            }
            if (aliases.get(file)!.has(binding.name.text)) fail(file, binding, `Duplicate type name ${binding.name.text}`);
            aliases.get(file)!.set(binding.name.text, {file: target, node: declaration});
        }
        const values = bindings.filter(b => !types.includes(b));
        if (node.importClause.name) fail(file, node.importClause.name, 'Default imports are unsupported');
        edits.get(file)!.push({start: node.getStart(sf), end: node.end, text: values.length ? `import { ${values.map(v => v.getText(sf)).join(', ')} } from ${node.moduleSpecifier.getText(sf)};` : ''});
    }
    let work = 0, expandedTotal = 0;
    // Budgets apply per alias expansion; unaliased type syntax is copied, not counted.
    function render(node: ts.TypeNode, file: string, stack: string[], site: {file: string; node: ts.Node}): string {
        if (stack.length && (++work > EXPANSION_WORK_LIMIT || stack.length > EXPANSION_DEPTH_LIMIT))
            fail(site.file, site.node, 'Type alias expansion exceeds the supported complexity limit');
        const sf = parsed.get(file)!;
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const alias = aliases.get(file)!.get(node.typeName.text);
            if (alias) {
                if (node.typeArguments?.length) fail(site.file, site.node, 'Generic type alias instantiation is unsupported');
                const key = alias.file + ':' + alias.node.name.text;
                if (stack.includes(key)) fail(site.file, site.node, `Recursive JSON type alias: ${alias.node.name.text}`);
                return `(${render(alias.node.type, alias.file, [...stack, key], site)})`;
            }
        }
        const changes: Edit[] = [];
        const walk = (child: ts.Node) => {
            if (ts.isTypeNode(child)) {
                const text = render(child, file, stack, stack.length ? site : {file, node: child});
                if (text !== child.getText(sf)) changes.push({start: child.getStart(sf), end: child.end, text});
                return;
            }
            ts.forEachChild(child, walk);
        };
        ts.forEachChild(node, walk);
        let text = node.getText(sf), start = node.getStart(sf);
        for (const e of changes.sort((a,b) => b.start-a.start)) text = text.slice(0,e.start-start)+e.text+text.slice(e.end-start);
        if (text.length > EXPANSION_TEXT_LIMIT) fail(site.file, site.node, 'Expanded JSON type exceeds the supported size limit');
        return text;
    }
    function expand(node: ts.TypeNode, file: string, stack: string[]): string {
        work = 0;
        const original = node.getText(parsed.get(file)!), text = render(node, file, stack, {file, node});
        if (text !== original && (expandedTotal += text.length) > PROGRAM_EXPANSION_LIMIT)
            fail(file, node, 'Expanded JSON types exceed the supported program size limit');
        return text;
    }
    const output: Record<string,string> = {};
    for (const [file, sf] of parsed) {
        const changes = edits.get(file)!;
        // Validate unused aliases too, rather than silently accepting unsupported definitions.
        for (const alias of aliases.get(file)!.values()) {
            if (alias.file !== file) continue;
            const text = expand(alias.node.type, alias.file, [alias.file+':'+alias.node.name.text]);
            const check = ts.createSourceFile(file, `type Check = ${text};`, ts.ScriptTarget.Latest, true);
            try {
                typeToValueType((check.statements[0] as ts.TypeAliasDeclaration).type);
            } catch (error) {
                fail(file, alias.node.type, (error as Error).message.replace(/^\d+:\d+\s+/, ''));
            }
        }
        const walk = (node: ts.Node) => {
            if (ts.isImportDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
            if (ts.isTypeNode(node)) {
                const text = expand(node, file, []);
                if (text !== node.getText(sf)) changes.push({start: node.getStart(sf), end: node.end, text});
                return;
            }
            ts.forEachChild(node, walk);
        };
        for (const node of sf.statements) walk(node);
        let text = sf.text;
        for (const e of changes.sort((a,b) => b.start-a.start)) text = text.slice(0,e.start)+e.text+text.slice(e.end);
        output[file] = text;
        changes.sort((a,b) => a.start-b.start);
    }
    function originalOffset(file: string, offset: number): number {
        let delta = 0;
        for (const e of edits.get(file)!) {
            const start = e.start + delta, end = start + e.text.length;
            if (offset < start) break;
            if (offset < end) return e.start;
            delta += e.text.length - (e.end-e.start);
        }
        return offset-delta;
    }
    return {files: output, dependencies, position(file: string, line: number, column: number) {
        if (!Object.hasOwn(output, file)) return {line, column};
        const transformed = ts.createSourceFile(file, output[file], ts.ScriptTarget.Latest, true);
        const starts = transformed.getLineStarts();
        if (line < 1 || line > starts.length) return {line, column};
        const offset = Math.min(starts[line - 1] + column - 1, output[file].length);
        const original = originalOffset(file, offset);
        const p = parsed.get(file)!.getLineAndCharacterOfPosition(original);
        return {line: p.line + 1, column: p.character + 1};
    }, remap(file: string, spans: Record<string, SourceSpan>) {
        return Object.fromEntries(Object.entries(spans).map(([id, span]) => {
            const start = originalOffset(file,span.start), end = Math.max(start, originalOffset(file,span.end));
            const {line,character} = parsed.get(file)!.getLineAndCharacterOfPosition(start);
            return [id,{start,end,line:line+1,column:character+1}];
        }));
    }};
}

import * as ts from 'typescript';
import { posix as path } from 'path';
import type { SourceSpan } from './ast-to-itt';
import { typeToValueType } from './type-contract';

type Edit = { start: number; end: number; text: string };
type Alias = { file: string; node: ts.TypeAliasDeclaration };
/** Pure, bounded expansion of JSON type aliases; no disk, package or runtime resolution. */
export function expandModuleTypes(files: Record<string, string>) {
    const parsed = new Map(Object.entries(files).map(([file, text]) => [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)]));
    const aliases = new Map<string, Map<string, Alias>>();
    const dependencies: Array<{from: string; to: string}> = [];
    const edits = new Map<string, Edit[]>();
    const exported = (node: ts.TypeAliasDeclaration) => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    const nominal = new Set(['FilePath', 'DirPath']);
    for (const [file, sf] of parsed) {
        const names = new Map<string, Alias>(); aliases.set(file, names); edits.set(file, []);
        for (const node of sf.statements) if (ts.isTypeAliasDeclaration(node) && !nominal.has(node.name.text)) {
            if (['Promise', 'Array', 'ReadonlyArray', 'Record'].includes(node.name.text)) throw new Error(`${file}: Reserved type name: ${node.name.text}`);
            if (node.typeParameters?.length) throw new Error(`${file}: Generic type aliases are unsupported: ${node.name.text}`);
            if (names.has(node.name.text)) throw new Error(`${file}: Duplicate type alias: ${node.name.text}`);
            names.set(node.name.text, {file, node});
            edits.get(file)!.push({start: node.getStart(sf), end: node.end, text: ''});
        }
    }
    for (const [file, sf] of parsed) for (const node of sf.statements) {
        if (!ts.isImportDeclaration(node) || !node.importClause || !node.importClause.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) continue;
        const bindings = node.importClause.namedBindings.elements;
        const types = bindings.filter(b => node.importClause!.isTypeOnly || b.isTypeOnly);
        if (!types.length) continue;
        if (!ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith('.')) throw new Error(`${file}: Type imports must reference supplied relative modules`);
        const base = path.normalize(path.join(path.dirname(file), node.moduleSpecifier.text));
        const target = (base.endsWith('.ts') ? [base] : [base + '.ts', base + '/index.ts']).find(p => parsed.has(p));
        if (!target || target.startsWith('../')) throw new Error(`${file}: Missing type module: ${base}`);
        dependencies.push({from: file, to: target});
        for (const binding of types) {
            const name = (binding.propertyName ?? binding.name).text;
            const declaration = parsed.get(target)!.statements.find(n => ts.isTypeAliasDeclaration(n) && n.name.text === name);
            if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !exported(declaration)) throw new Error(`${file}: Module ${target} does not export a supported JSON type alias ${name}`);
            if (nominal.has(name)) {
                if (binding.name.text !== name || declaration.type.kind !== ts.SyntaxKind.StringKeyword)
                    throw new Error(`${file}: Path marker imports must retain their name and string declaration`);
                continue; // Preserve nominal path semantics instead of expanding to plain string.
            }
            if (aliases.get(file)!.has(binding.name.text)) throw new Error(`${file}: Duplicate type name ${binding.name.text}`);
            aliases.get(file)!.set(binding.name.text, {file: target, node: declaration});
        }
        const values = bindings.filter(b => !types.includes(b));
        if (node.importClause.name) throw new Error(`${file}: Default imports are unsupported`);
        edits.get(file)!.push({start: node.getStart(sf), end: node.end, text: values.length ? `import { ${values.map(v => v.getText(sf)).join(', ')} } from ${node.moduleSpecifier.getText(sf)};` : ''});
    }
    let work = 0;
    function render(node: ts.TypeNode, file: string, stack: string[]): string {
        if (++work > 20000 || stack.length > 64) throw new Error('Type alias expansion exceeds the supported complexity limit');
        const sf = parsed.get(file)!;
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const alias = aliases.get(file)!.get(node.typeName.text);
            if (alias) {
                if (node.typeArguments?.length) throw new Error(`${file}: Generic type alias instantiation is unsupported`);
                const key = alias.file + ':' + alias.node.name.text;
                if (stack.includes(key)) throw new Error(`Recursive JSON type alias: ${key}`);
                return `(${render(alias.node.type, alias.file, [...stack, key])})`;
            }
        }
        const changes: Edit[] = [];
        const walk = (child: ts.Node) => {
            if (ts.isTypeNode(child)) { changes.push({start: child.getStart(sf), end: child.end, text: render(child, file, stack)}); return; }
            ts.forEachChild(child, walk);
        };
        ts.forEachChild(node, walk);
        let text = node.getText(sf), start = node.getStart(sf);
        for (const e of changes.sort((a,b) => b.start-a.start)) text = text.slice(0,e.start-start)+e.text+text.slice(e.end-start);
        if (text.length > 200000) throw new Error('Expanded JSON type exceeds the supported size limit');
        return text;
    }
    const output: Record<string,string> = {};
    for (const [file, sf] of parsed) {
        const changes = edits.get(file)!;
        // Validate unused aliases too, rather than silently accepting unsupported definitions.
        for (const alias of aliases.get(file)!.values()) {
            const text = render(alias.node.type, alias.file, [alias.file+':'+alias.node.name.text]);
            const check = ts.createSourceFile(file, `type Check = ${text};`, ts.ScriptTarget.Latest, true);
            typeToValueType((check.statements[0] as ts.TypeAliasDeclaration).type);
        }
        const walk = (node: ts.Node) => {
            if (ts.isImportDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
            if (ts.isTypeNode(node)) {
                const text = render(node, file, []);
                if (text !== node.getText(sf)) changes.push({start: node.getStart(sf), end: node.end, text});
                return;
            }
            if (ts.isIdentifier(node) && aliases.get(file)!.has(node.text) &&
                !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
                !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) throw new Error(`${file}: Type alias ${node.text} cannot be used as a runtime value`);
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
        const transformed = ts.createSourceFile(file, output[file], ts.ScriptTarget.Latest, true);
        const offset = transformed.getPositionOfLineAndCharacter(line - 1, column - 1);
        const original = originalOffset(file, offset);
        const p = parsed.get(file)!.getLineAndCharacterOfPosition(original);
        return {line: p.line + 1, column: p.character + 1};
    }, remap(file: string, spans: Record<string, SourceSpan>) {
        return Object.fromEntries(Object.entries(spans).map(([id, span]) => {
            const start = originalOffset(file,span.start), end = originalOffset(file,span.end);
            const {line,character} = parsed.get(file)!.getLineAndCharacterOfPosition(start);
            return [id,{start,end,line:line+1,column:character+1}];
        }));
    }};
}

import {readdirSync, readFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import ts = require('typescript');

test('distributed source imports use only local modules, selection/data contracts and Node builtins', () => {
    const root = resolve(__dirname, '..');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@openhilo/itt-contracts']);
    expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([]);
    expect(manifest.files).toEqual(['dist', 'README.md', 'THIRD_PARTY_NOTICES.txt']);
    const walk = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
    for (const file of walk(join(root, 'src')).filter(file => file.endsWith('.ts'))) {
        const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const inspect = (node: ts.Node): void => {
            let specifier: ts.Node | undefined;
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
            if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
            if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
            if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                expect(node.arguments).toHaveLength(1);
                specifier = node.arguments[0];
            }
            if (specifier) {
                expect(ts.isStringLiteral(specifier)).toBe(true);
                const value = (specifier as ts.StringLiteral).text;
                if (['@openhilo/itt-contracts/ai-selection', '@openhilo/itt-contracts/run-inputs'].includes(value) || value === 'node:crypto') return;
                expect(value.startsWith('.')).toBe(true);
                const path = relative(join(root, 'src'), resolve(file, '..', value));
                expect(path.startsWith('..') || isAbsolute(path)).toBe(false);
            }
            ts.forEachChild(node, inspect);
        };
        inspect(ast);
    }
});

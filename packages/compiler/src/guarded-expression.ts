import * as ts from 'typescript';
import {VALUE_GUARD} from './expression-policy';

type Member = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/**
 * Lower whole optional chains before inserting read guards. Wrapping an inner
 * `a?.b` first would end its short circuit. TypeScript owns chain boundaries,
 * single evaluation, receiver binding and type erasure; we only guard original
 * member reads, never its generated temporary/receiver plumbing.
 */
export function guardOptionalExpression(text: string, shouldGuard: (node: Member) => boolean): string {
    const reads = new Set<ts.Node>();
    const result = ts.transpileModule(`(() => (${text}\n))();`, {
        compilerOptions: {target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.ESNext},
        reportDiagnostics: true,
        transformers: {
            before: [() => source => {
                const collect = (node: ts.Node): void => {
                    if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return;
                    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && shouldGuard(node)) reads.add(node);
                    ts.forEachChild(node, collect);
                };
                collect(source);
                return source;
            }],
            after: [context => source => {
                const visit: ts.Visitor = node => {
                    const updated = ts.visitEachChild(node, visit, context);
                    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && reads.has(ts.getOriginalNode(node))) {
                        return context.factory.createCallExpression(context.factory.createIdentifier(VALUE_GUARD), undefined, [updated as ts.Expression]);
                    }
                    return updated;
                };
                return ts.visitNode(source, visit) as ts.SourceFile;
            }],
        },
    });
    if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error))
        throw new Error('Optional-chain expression cannot be emitted as JavaScript');
    // The immediate arrow owns all lowering temporaries. None becomes workflow
    // state, leaks into another expression, or needs a checkpoint representation.
    const output = ts.createSourceFile('expression.js', result.outputText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    // TypeScript 6 adds a strict-mode directive. Runtime already evaluates in
    // strict mode; permit only that leading directive, never helper statements.
    const first = output.statements[0];
    const statements = first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use strict'
        ? output.statements.slice(1) : output.statements;
    const statement = statements[0];
    if (statements.length !== 1 || !statement || !ts.isExpressionStatement(statement))
        throw new Error('Optional-chain expression emitted unexpected helper statements');
    return statement.expression.getText(output);
}

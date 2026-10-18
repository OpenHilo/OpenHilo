import * as ts from 'typescript';

/** Syntax-only wrappers: never follow aliases or evaluate a dynamic selector. */
export function unwrapExpression(node: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    return node;
}

export function staticMember(node: ts.Expression): { base: ts.Expression; key: string } | undefined {
    node = unwrapExpression(node);
    if (ts.isPropertyAccessExpression(node)) return {base: unwrapExpression(node.expression), key: node.name.text};
    if (ts.isElementAccessExpression(node)) {
        const key = unwrapExpression(node.argumentExpression);
        if (ts.isStringLiteralLike(key)) return {base: unwrapExpression(node.expression), key: key.text};
    }
    return undefined;
}

export function directCallee(call: ts.CallExpression): ts.Identifier | undefined {
    const target = unwrapExpression(call.expression);
    return ts.isIdentifier(target) ? target : undefined;
}

/** The entire expression is a known awaited call, modulo erased wrappers. */
export function awaitedCall(expression: ts.Expression): ts.CallExpression | undefined {
    const value = unwrapExpression(expression);
    if (!ts.isAwaitExpression(value)) return undefined;
    const call = unwrapExpression(value.expression);
    return ts.isCallExpression(call) ? call : undefined;
}

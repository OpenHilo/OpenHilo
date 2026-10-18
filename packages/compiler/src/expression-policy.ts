import * as ts from 'typescript';
import {staticMember, unwrapExpression} from './expression-forms';

export const KEY_GUARD = '__openhilo_property_key__';
export const VALUE_GUARD = '__openhilo_data_value__';
export const RESULT_GUARD = '__openhilo_return_value__';

export function expressionConsumer(node: ts.Node): ts.Node {
    while (node.parent && (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent) || ts.isNonNullExpression(node.parent) || ts.isSatisfiesExpression(node.parent)) && node.parent.expression === node) node = node.parent;
    return node;
}

export function isDirectCallTarget(node: ts.Node): boolean {
    const consumer = expressionConsumer(node);
    return !!consumer.parent && ts.isCallExpression(consumer.parent) && consumer.parent.expression === consumer;
}

export const REFLECTION_KEYS = new Set(['constructor', 'prototype', '__proto__']);
export const VALUE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);
const callableGlobals = new Set(['Array', 'Object', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Date', 'RegExp']);
const operations: Record<string, Set<string>> = {
    Math: new Set('abs acos acosh asin asinh atan atanh atan2 cbrt ceil clz32 cos cosh exp expm1 floor fround hypot imul log log1p log2 log10 max min pow random round sign sin sinh sqrt tan tanh trunc'.split(' ')),
    JSON: new Set(['parse', 'stringify']),
    Array: new Set(['from', 'isArray', 'of']),
    Object: new Set(['assign', 'keys', 'values', 'entries', 'fromEntries', 'is', 'hasOwn']),
    String: new Set(['fromCharCode', 'fromCodePoint']),
    Number: new Set(['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt']),
    Date: new Set(['now', 'parse', 'UTC']),
};
const constants: Record<string, Set<string>> = {
    Math: new Set('E LN2 LN10 LOG2E LOG10E PI SQRT1_2 SQRT2'.split(' ')),
    Number: new Set('EPSILON MAX_SAFE_INTEGER MIN_SAFE_INTEGER MAX_VALUE MIN_VALUE POSITIVE_INFINITY NEGATIVE_INFINITY NaN'.split(' ')),
};

export function policyError(node: ts.Node, sf: ts.SourceFile, message: string): never {
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new Error(`${p.line + 1}:${p.character + 1} ${message}`);
}

function callbackArgument(node: ts.Node): boolean {
    node = expressionConsumer(node);
    const p = node.parent;
    return ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression) &&
        !!staticMember(p.expression) &&
        ['map', 'filter', 'reduce', 'reduceRight', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap', 'sort', 'toSorted', 'forEach', 'from', 'replace', 'replaceAll'].includes(staticMember(p.expression)!.key);
}

export function validateGlobalUse(node: ts.Identifier, sf: ts.SourceFile): void {
    const name = node.text, target = expressionConsumer(node), parent = target.parent;
    if (VALUE_GLOBALS.has(name)) return;
    if (callableGlobals.has(name) && (isDirectCallTarget(node) ||
        (name === 'Array' && ts.isNewExpression(parent) && unwrapExpression(parent.expression) === node) ||
        (['Number', 'String', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite'].includes(name) && callbackArgument(node)))) return;
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
        const member = staticMember(parent);
        if (member?.base === node) {
            if (operations[name]?.has(member.key) && isDirectCallTarget(parent)) return;
            if (constants[name]?.has(member.key)) {
                const access = expressionConsumer(parent), consumer = access.parent;
                if (!((ts.isBinaryExpression(consumer) && consumer.left === access && consumer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && consumer.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
                    ((ts.isPrefixUnaryExpression(consumer) || ts.isPostfixUnaryExpression(consumer)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(consumer.operator)))) return;
            }
        }
    }
    policyError(node, sf, `Unsupported global/intrinsic use '${name}'; use documented direct operations or a Code capability`);
}

export function assertPatternKey(key: ts.Node, sf: ts.SourceFile): void {
    if (ts.isComputedPropertyName(key)) policyError(key, sf, 'Computed destructuring keys are unsupported; use an explicit guarded member access');
    if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && REFLECTION_KEYS.has(key.text))
        policyError(key, sf, `Prototype/constructor reflection '${key.text}' is unsupported in binding patterns`);
}

function inspectAssignmentPattern(node: ts.Expression, sf: ts.SourceFile): void {
    if (ts.isParenthesizedExpression(node)) return inspectAssignmentPattern(node.expression, sf);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return inspectAssignmentPattern(node.left, sf);
    if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) inspectAssignmentPattern(element, sf);
    if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
            assertPatternKey(property.name, sf);
            inspectAssignmentPattern(property.initializer, sf);
        }
        if (ts.isShorthandPropertyAssignment(property)) assertPatternKey(property.name, sf);
    }
}

const admitted = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.ParenthesizedExpression, ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.ObjectLiteralExpression,
    ts.SyntaxKind.PropertyAssignment, ts.SyntaxKind.ShorthandPropertyAssignment, ts.SyntaxKind.SpreadAssignment, ts.SyntaxKind.SpreadElement, ts.SyntaxKind.OmittedExpression,
    ts.SyntaxKind.PropertyAccessExpression, ts.SyntaxKind.ElementAccessExpression, ts.SyntaxKind.CallExpression, ts.SyntaxKind.NewExpression,
    ts.SyntaxKind.BinaryExpression, ts.SyntaxKind.PrefixUnaryExpression, ts.SyntaxKind.PostfixUnaryExpression, ts.SyntaxKind.ConditionalExpression,
    ts.SyntaxKind.TypeOfExpression, ts.SyntaxKind.TemplateExpression, ts.SyntaxKind.TemplateSpan,
    ts.SyntaxKind.AsExpression, ts.SyntaxKind.TypeAssertionExpression, ts.SyntaxKind.NonNullExpression, ts.SyntaxKind.SatisfiesExpression,
    ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.Parameter,
    ts.SyntaxKind.Block, ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.VariableDeclarationList, ts.SyntaxKind.VariableDeclaration,
    ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.BreakStatement, ts.SyntaxKind.ContinueStatement, ts.SyntaxKind.EmptyStatement,
    ts.SyntaxKind.ObjectBindingPattern, ts.SyntaxKind.ArrayBindingPattern, ts.SyntaxKind.BindingElement,
    ts.SyntaxKind.ComputedPropertyName,
]);

export function validateExpressionSyntax(node: ts.Expression, sf: ts.SourceFile): void {
    const visit = (current: ts.Node): void => {
        if (ts.isTypeNode(current) || ts.isTypeParameterDeclaration(current)) return;
        if (current.kind === ts.SyntaxKind.ThisKeyword || current.kind === ts.SyntaxKind.SuperKeyword || current.kind === ts.SyntaxKind.BigIntLiteral)
            policyError(current, sf, `Unsupported expression ${ts.SyntaxKind[current.kind]}`);
        if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
            policyError(current, sf, 'instanceof is unsupported across workflow VM contexts; use Array.isArray or data tags');
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
            const member = staticMember(current);
            if (member && REFLECTION_KEYS.has(member.key))
                policyError(current, sf, `Prototype/constructor reflection '${member.key}' is unsupported`);
        }
        if (ts.isBindingElement(current) && ts.isObjectBindingPattern(current.parent)) assertPatternKey(current.propertyName ?? current.name, sf);
        if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) inspectAssignmentPattern(current.left, sf);
        if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
            if (current.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) || (ts.isFunctionExpression(current) && current.asteriskToken))
                policyError(current, sf, 'Async/generator callbacks are unsupported; use explicit workflow calls');
            const consumer = expressionConsumer(current);
            if (!(ts.isCallExpression(consumer.parent) && consumer.parent.expression === consumer) && !callbackArgument(current))
                policyError(current, sf, 'Functions are supported only as synchronous callbacks or immediate expressions, not as values');
        }
        if (!(current.kind >= ts.SyntaxKind.FirstToken && current.kind <= ts.SyntaxKind.LastToken) && !admitted.has(current.kind))
            policyError(current, sf, `Unsupported expression syntax ${ts.SyntaxKind[current.kind]}`);
        ts.forEachChild(current, visit);
    };
    visit(node);
}

/** Conservative check of the value being saved, not a whole-program evaluator. */
export function assertStaticState(node: ts.Expression, sf: ts.SourceFile, isGlobal: (node: ts.Identifier) => boolean): void {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return assertStaticState(node.expression, sf, isGlobal);
    if ((ts.isIdentifier(node) && VALUE_GLOBALS.has(node.text) && isGlobal(node)) || ts.isRegularExpressionLiteral(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || node.kind === ts.SyntaxKind.BigIntLiteral ||
        (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand) && Number(node.operand.text) === 0))
        policyError(node, sf, 'Statically unsupported persistent value; store ordinary data and use null/defaults for missing values');
    if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) policyError(element, sf, 'Sparse arrays are unsupported persistent values');
        if (!ts.isSpreadElement(element)) assertStaticState(element, sf, isGlobal);
    }
    if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) assertStaticState(property.initializer, sf, isGlobal);
    }
}

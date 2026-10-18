import {directCallee} from './expression-forms';
import * as ts from 'typescript';

export interface AiFunctionInfo {
    fnName: string;
    role: string;
    intent: string;
    currentSkills: string[];
}

/**
 * Parse a TS source string and return info about each _by_ai declare function:
 * - fnName, role + intent extracted from the first call site,
 * - currentSkills from the declaration's `skills` default (empty if absent).
 */
export function extractAiFunctions(src: string): AiFunctionInfo[] {
    const sf = ts.createSourceFile('annotate.ts', src, ts.ScriptTarget.Latest, true);
    const results: AiFunctionInfo[] = [];

    // 1. Collect all _by_ai declare-function nodes
    const declNodes = new Map<string, ts.FunctionDeclaration>();
    ts.forEachChild(sf, node => {
        if (
            ts.isFunctionDeclaration(node) &&
            node.name &&
            node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword) &&
            node.name.text.endsWith('_by_ai')
        ) {
            declNodes.set(node.name.text, node);
        }
    });

    // 2. Collect first call site for each _by_ai function
    const callSites = new Map<string, ts.CallExpression>();

    function visitForCalls(node: ts.Node): void {
        if (
            ts.isCallExpression(node) &&
            directCallee(node) &&
            directCallee(node)!.text.endsWith('_by_ai') &&
            !callSites.has(directCallee(node)!.text)
        ) {
            callSites.set(directCallee(node)!.text, node);
        }
        ts.forEachChild(node, visitForCalls);
    }

    ts.forEachChild(sf, visitForCalls);

    // 3. Build AiFunctionInfo for each declaration
    for (const [fnName, declNode] of declNodes) {
        const params = Array.from(declNode.parameters);

        // Extract currentSkills from last `skills: string[]` param
        let currentSkills: string[] = [];
        const lastParam = params[params.length - 1];
        if (
            lastParam &&
            ts.isIdentifier(lastParam.name) &&
            lastParam.name.text === 'skills' &&
            lastParam.initializer &&
            ts.isArrayLiteralExpression(lastParam.initializer)
        ) {
            currentSkills = lastParam.initializer.elements.map(el =>
                ts.isStringLiteral(el) ? el.text : el.getText(sf),
            );
        }

        // Extract role + intent from first call site (prefix args 0 and 1)
        let role = '';
        let intent = '';
        const callExpr = callSites.get(fnName);
        if (callExpr) {
            const args = Array.from(callExpr.arguments);
            if (args[0] && ts.isStringLiteral(args[0])) role = args[0].text;
            if (args[1] && ts.isStringLiteral(args[1])) intent = args[1].text;
        }

        results.push({fnName, role, intent, currentSkills});
    }

    return results;
}

/**
 * Rewrite the `skills` default value in a single `_by_ai` declare-function.
 * Replaces `skills: string[]` or `skills: string[] = [...]` with
 * `skills: string[] = ['ns:skill', ...]`.
 * Returns the modified source string unchanged if the function is not found.
 */
export function rewriteSkillsDefault(src: string, fnName: string, skills: string[]): string {
    const sf = ts.createSourceFile('annotate.ts', src, ts.ScriptTarget.Latest, true);
    const declaration = sf.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
        && node.name?.text === fnName && !!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword));
    const parameter = declaration?.parameters.find(node => ts.isIdentifier(node.name) && node.name.text === 'skills');
    if (!parameter?.type || parameter.questionToken || !ts.isArrayTypeNode(parameter.type)
        || parameter.type.elementType.kind !== ts.SyntaxKind.StringKeyword) return src;
    const printer = ts.createPrinter();
    const values = skills.map(value => printer.printNode(ts.EmitHint.Expression, ts.factory.createStringLiteral(value, true), sf));
    const literal = `[${values.join(', ')}]`;
    const from = parameter.initializer?.getStart(sf) ?? parameter.end;
    const to = parameter.initializer?.end ?? parameter.end;
    return src.slice(0, from) + (parameter.initializer ? literal : ` = ${literal}`) + src.slice(to);
}


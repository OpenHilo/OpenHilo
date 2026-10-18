import * as ts from 'typescript';
import {LexicalBindings} from './lexical-bindings';
import {assertPatternKey} from './expression-policy';

/** Render only supported patterns; JS itself supplies binding/default/rest semantics. */
export function renderBindingPattern(
    node: ts.BindingName | ts.Expression,
    mode: 'declare' | 'assign',
    bindings: LexicalBindings,
    expression: (node: ts.Expression) => string,
    knownOwnOutputKeys?: ReadonlySet<string>,
): { text: string; names: string[] } {
    const names = new Set<string>();
    const patternRoot = node;

    function key(node: ts.PropertyName): string {
        // Awaited named outputs are constructed as own data fields by the compiler.
        // Only their top-level declared keys are exempt; nested reflection is not.
        const topLevelOutput = ts.isBindingElement(node.parent) && node.parent.parent === patternRoot &&
            (ts.isIdentifier(node) || ts.isStringLiteral(node)) && knownOwnOutputKeys?.has(node.text);
        if (!topLevelOutput) assertPatternKey(node, node.getSourceFile());
        if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return JSON.stringify(node.text);
        throw new Error('Destructuring keys must be static; computed keys are unsupported');
    }

    function fallback(node: ts.Expression): string {
        function inspect(node: ts.Node): void {
            if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) throw new Error('Destructuring defaults cannot suspend or await');
            ts.forEachChild(node, inspect);
        }

        inspect(node);
        return `(${expression(node)})`;
    }

    function rest(node: ts.Node, index: number, length: number, trailingComma: boolean, object: boolean): string {
        if (index !== length - 1 || trailingComma) throw new Error('Destructuring rest must be last without a trailing comma');
        const target = ts.isBindingElement(node) ? node.name :
            ts.isSpreadElement(node) || ts.isSpreadAssignment(node) ? node.expression : node;
        if ((ts.isBindingElement(node) && node.initializer) || (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken))
            throw new Error('Destructuring rest cannot have a default');
        if (object && !ts.isIdentifier(target)) throw new Error('Object rest requires a variable target');
        return `...${render(target)}`;
    }

    function render(node: ts.Node): string {
        if (ts.isIdentifier(node)) {
            if (mode === 'assign') bindings.assertAssignmentTarget(node);
            const name = bindings.name(node);
            names.add(name);
            return name;
        }
        if (ts.isBindingElement(node)) {
            const target = render(node.name);
            return node.initializer ? `${target} = ${fallback(node.initializer)}` : target;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
            return `${render(node.left)} = ${fallback(node.right)}`;
        if (ts.isArrayBindingPattern(node) || ts.isArrayLiteralExpression(node)) {
            const parts = node.elements.map((element, index) => {
                if (ts.isOmittedExpression(element)) return '';
                if ((ts.isBindingElement(element) && element.dotDotDotToken) || ts.isSpreadElement(element))
                    return rest(element, index, node.elements.length, !!node.elements.hasTrailingComma, false);
                return render(element);
            });
            // A final omitted element needs its comma to remain an iterator step.
            return `[${parts.join(',')}${node.elements.length && ts.isOmittedExpression(node.elements[node.elements.length - 1]) ? ',' : ''}]`;
        }
        if (ts.isObjectBindingPattern(node)) {
            return `{${node.elements.map((element, index) => {
                if (element.dotDotDotToken) return rest(element, index, node.elements.length, !!node.elements.hasTrailingComma, true);
                const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
                if (!property) throw new Error('Nested object patterns require an explicit property key');
                return `${key(property)}: ${render(element)}`;
            }).join(',')}}`;
        }
        if (ts.isObjectLiteralExpression(node)) {
            return `{${node.properties.map((property, index) => {
                if (ts.isSpreadAssignment(property)) return rest(property, index, node.properties.length, !!node.properties.hasTrailingComma, true);
                if (ts.isPropertyAssignment(property)) return `${key(property.name)}: ${render(property.initializer)}`;
                if (ts.isShorthandPropertyAssignment(property)) {
                    const target = render(property.name);
                    return `${key(property.name)}: ${target}${property.objectAssignmentInitializer ? ` = ${fallback(property.objectAssignmentInitializer)}` : ''}`;
                }
                throw new Error('Unsupported object destructuring property');
            }).join(',')}}`;
        }
        throw new Error('Destructuring targets must be variable names or nested patterns; property targets are unsupported');
    }

    return {text: render(node), names: [...names]};
}

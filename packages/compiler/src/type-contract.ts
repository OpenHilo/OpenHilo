import * as ts from 'typescript';
import type {ValueType} from '@openhilo/itt-contracts';

function unsupported(node: ts.Node, reason = 'Unsupported workflow data type'): never {
    const sf = node.getSourceFile();
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    throw new Error(`${p.line + 1}:${p.character + 1} ${reason}: ${node.getText(sf)}`);
}

/** Coarse data contracts, not structural validation or a TypeScript type checker. */
export function typeToValueType(node: ts.TypeNode | undefined): ValueType {
    if (!node) return 'json';
    if (ts.isParenthesizedTypeNode(node)) return typeToValueType(node.type);
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) return typeToValueType(node.type);
    switch (node.kind) {
        case ts.SyntaxKind.StringKeyword:
            return 'text';
        case ts.SyntaxKind.NumberKeyword:
            return 'number';
        case ts.SyntaxKind.BooleanKeyword:
            return 'boolean';
        case ts.SyntaxKind.ObjectKeyword:
        case ts.SyntaxKind.AnyKeyword:
        case ts.SyntaxKind.UnknownKeyword:
            return 'json';
    }
    if (ts.isLiteralTypeNode(node)) {
        if (ts.isStringLiteral(node.literal)) return 'text';
        if (ts.isNumericLiteral(node.literal) || (ts.isPrefixUnaryExpression(node.literal) && ts.isNumericLiteral(node.literal.operand))) return 'number';
        if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.literal.kind)) return 'boolean';
        if (node.literal.kind === ts.SyntaxKind.NullKeyword) return 'json';
    }
    if (ts.isArrayTypeNode(node)) {
        typeToValueType(node.elementType);
        return 'json';
    }
    if (ts.isTupleTypeNode(node)) {
        for (let element of node.elements) {
            if (ts.isNamedTupleMember(element) || ts.isOptionalTypeNode(element) || ts.isRestTypeNode(element)) element = element.type;
            typeToValueType(element);
        }
        return 'json';
    }
    if (ts.isUnionTypeNode(node)) {
        const kinds = node.types.map(typeToValueType);
        return kinds.every(kind => kind === kinds[0]) ? kinds[0] : 'json';
    }
    if (ts.isTypeLiteralNode(node)) {
        for (const member of node.members) {
            if (ts.isPropertySignature(member)) typeToValueType(member.type);
            else if (ts.isIndexSignatureDeclaration(member)) {
                for (const parameter of member.parameters) {
                    const key = typeToValueType(parameter.type);
                    if (key !== 'text' && key !== 'number') unsupported(parameter, 'Unsupported data index key type');
                }
                typeToValueType(member.type);
            } else unsupported(member);
        }
        return 'json';
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const name = node.typeName.text, args = node.typeArguments ?? [];
        if ((name === 'FilePath' || name === 'DirPath') && !args.length) return name === 'FilePath' ? 'file' : 'dir';
        if ((name === 'Array' || name === 'ReadonlyArray') && args.length === 1) {
            typeToValueType(args[0]);
            return 'json';
        }
        if (name === 'Record' && args.length === 2) {
            const key = typeToValueType(args[0]);
            if (key !== 'text' && key !== 'number') unsupported(args[0], 'Unsupported Record key type');
            typeToValueType(args[1]);
            return 'json';
        }
    }
    return unsupported(node);
}

/** Workflow output names must be statically declared; never silently omit members. */
export function outputFields(node: ts.TypeNode | undefined): { name: string; kind: ValueType }[] {
    if (!node) return [];
    while (ts.isParenthesizedTypeNode(node)) node = node.type;
    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName) || node.typeName.text !== 'Promise' || node.typeArguments?.length !== 1)
        return unsupported(node, 'Output contract requires Promise with explicit named fields');
    let inner = node.typeArguments[0];
    while (ts.isParenthesizedTypeNode(inner)) inner = inner.type;
    if (inner.kind === ts.SyntaxKind.VoidKeyword) return [];
    if (!ts.isTypeLiteralNode(inner)) return unsupported(inner, 'Output contract requires explicit named fields');
    const seen = new Set<string>();
    return inner.members.map(member => {
        if (!ts.isPropertySignature(member) || member.questionToken || !member.name ||
            !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)))
            return unsupported(member, 'Output contract requires required static named fields');
        const name = member.name.text;
        if (seen.has(name)) return unsupported(member, 'Duplicate output contract field');
        seen.add(name);
        return {name, kind: typeToValueType(member.type)};
    });
}

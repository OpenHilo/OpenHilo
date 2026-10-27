import type { InputShape } from '@openhilo/itt-contracts/run-inputs';
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
export function outputFields(node: ts.TypeNode | undefined, preserveShape = false): { name: string; kind: ValueType; shape?: InputShape }[] {
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
        return {name, kind: typeToValueType(member.type), ...(preserveShape ? {shape: typeToInputShape(member.type)} : {})};
    });
}

/** Preserve entry input structure in addition to its transport kind. No new TS syntax is accepted here. */
export function typeToInputShape(node: ts.TypeNode | undefined): InputShape {
    const kind = typeToValueType(node);
    if (!node) return {type: 'json'};
    if (ts.isParenthesizedTypeNode(node) || (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword)) return typeToInputShape(node.type);
    if (ts.isLiteralTypeNode(node)) {
        const literal = node.literal;
        if (literal.kind === ts.SyntaxKind.NullKeyword) return {type: 'null'};
        if (ts.isStringLiteral(literal)) return {type: 'literal', value: literal.text};
        if (literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) return {type: 'literal', value: literal.kind === ts.SyntaxKind.TrueKeyword};
        return {type: 'literal', value: ts.isPrefixUnaryExpression(literal) ? (literal.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * Number((literal.operand as ts.NumericLiteral).text) : Number((literal as ts.NumericLiteral).text)};
    }
    if (ts.isUnionTypeNode(node)) return {type: 'union', options: node.types.map(typeToInputShape)};
    if (ts.isArrayTypeNode(node)) return {type: 'array', items: typeToInputShape(node.elementType)};
    if (ts.isTupleTypeNode(node)) {
        const items: Extract<InputShape, {type: 'tuple'}>['items'] = [];
        for (const element of node.elements) {
            const named = ts.isNamedTupleMember(element);
            const optional = named ? !!element.questionToken : ts.isOptionalTypeNode(element);
            const rest = named ? !!element.dotDotDotToken : ts.isRestTypeNode(element);
            const type = named || ts.isOptionalTypeNode(element) || ts.isRestTypeNode(element) ? element.type : element;
            const shape = typeToInputShape(type);
            if (rest && shape.type === 'tuple') items.push(...shape.items);
            else if (rest && shape.type === 'array') items.push({shape: shape.items, rest: true});
            else items.push({shape, ...(optional ? {optional: true} : {})});
        }
        return {type: 'tuple', items};
    }
    if (ts.isTypeLiteralNode(node)) {
        const properties: Extract<InputShape, {type: 'object'}>['properties'] = {};
        let additional: InputShape | undefined;
        let numericAdditional: InputShape | undefined;
        for (const member of node.members) {
            if (ts.isPropertySignature(member) && member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name))) {
                Object.defineProperty(properties, member.name.text, {enumerable: true, configurable: true, value: {shape: typeToInputShape(member.type), ...(member.questionToken ? {optional: true} : {})}});
            } else if (ts.isIndexSignatureDeclaration(member)) {
                if (typeToValueType(member.parameters[0]?.type) === 'number') numericAdditional = typeToInputShape(member.type);
                else additional = typeToInputShape(member.type);
            } else unsupported(member, 'Input fields require static property names');
        }
        return {type: 'object', properties, ...(additional ? {additional} : {}), ...(numericAdditional ? {numericAdditional} : {})};
    }
    if (node.kind === ts.SyntaxKind.ObjectKeyword) return {type: 'union', options: [{type: 'object', properties: {}, additional: {type: 'json'}}, {type: 'array', items: {type: 'json'}}]};
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const args = node.typeArguments ?? [];
        if (node.typeName.text === 'Array' || node.typeName.text === 'ReadonlyArray') return {type: 'array', items: typeToInputShape(args[0])};
        if (node.typeName.text === 'Record') {
            const keys = typeToInputShape(args[0]), value = typeToInputShape(args[1]);
            const options = keys.type === 'union' ? keys.options : [keys];
            if (options.every(key => key.type === 'literal')) return {type: 'object', properties: Object.fromEntries(options.map(key => [String((key as Extract<InputShape, {type: 'literal'}>).value), {shape: value}]))};
            return {type: 'object', properties: {}, additional: value, numericKeys: typeToValueType(args[0]) === 'number'};
        }
    }
    return {type: kind};
}

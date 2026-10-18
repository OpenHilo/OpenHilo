import type {AiSelection} from '@openhilo/itt-contracts/ai-selection';
import {readAiSelections} from './ai-selection-tags';
import {expressionConsumer} from './expression-policy';
import {outputFields, typeToValueType} from './type-contract';
import {awaitedCall, directCallee, unwrapExpression} from './expression-forms';
// src/translator/ts-validator.ts
import * as ts from 'typescript';
import type {ValueType} from '@openhilo/itt-contracts';

export interface CallDeclaration {
    fnName: string;
    executor: 'ai' | 'human' | 'code' | 'sys' | 'intent';
    callee: string;
    prefixCount: number;
    prefixParams: AIPrefixParams | HumanPrefixParams | CodePrefixParams;
    inputs: { name: string; kind: ValueType }[];
    outputs: { name: string; kind: ValueType }[];
    aiSelection?: AiSelection;
    skills?: string[];  // ai only: default value from last skills param
}

export interface AIPrefixParams {
    role: string;
    prompt: string;
    constraints?: string[];
}

export interface HumanPrefixParams {
    prompt: string;
    constraints?: string[];
}

export interface CodePrefixParams {
    lang: 'bash' | 'py';
}

export type ValidationResult =
    | { ok: true; sourceFile: ts.SourceFile; declarations: CallDeclaration[] }
    | { ok: false; errors: string[] };

export type SystemMethodRegistry = Record<string, { params: string[]; outputs: { name: string; kind: ValueType }[] }>;

export function validateTranslatorTs(source: string, systemMethods: SystemMethodRegistry = {}): ValidationResult {
    const errors: string[] = [];
    const sourceFile = ts.createSourceFile('translate.ts', source, ts.ScriptTarget.Latest, true);
    const syntax = ts.transpileModule(source, {
        fileName: 'translate.ts', reportDiagnostics: true,
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}
    }).diagnostics ?? [];
    for (const diagnostic of syntax) {
        const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        errors.push(`${location.line + 1}:${location.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
    if (errors.length) return {ok: false, errors};
    const aiSelections = readAiSelections(sourceFile, errors);
    const callableNames = new Set(Object.keys(systemMethods).map(name => `${name}_by_sys`));
    const registerCallable = (name: string, node: ts.Node): void => {
        if (callableNames.has(name)) errors.push(`${pos(node)} Duplicate callable name '${name}'; workflows, executors, imports and system capabilities must have distinct names`);
        callableNames.add(name);
    };
    for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) registerCallable(statement.name.text, statement.name);
        if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings))
            statement.importClause.namedBindings.elements.forEach(binding => registerCallable(binding.name.text, binding.name));
    }

    function pos(node: ts.Node): string {
        const {line, character} = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        return `${line + 1}:${character + 1}`;
    }

    // Pre-populate declarations with all _by_sys builtins (no 'declare' needed in source)
    const sysBuiltins: CallDeclaration[] = Object.entries(systemMethods).map(([method, def]) => ({
        fnName: `${method}_by_sys`,
        executor: 'sys' as const,
        callee: method,
        prefixCount: 0,
        prefixParams: {} as AIPrefixParams,
        inputs: def.params.map(p => ({name: p, kind: 'json' as ValueType})),
        outputs: def.outputs,
    }));

    // User declarations go first; sys builtins appended after
    const declarations: CallDeclaration[] = [];

    function walk(node: ts.Node): void {
        // var declarations
        if (ts.isVariableDeclarationList(node)) {
            const flags = node.flags;
            if (!(flags & ts.NodeFlags.Let) && !(flags & ts.NodeFlags.Const)) {
                errors.push(`${pos(node)}  var declarations are forbidden`);
            }
        }
        // class / interface / type alias
        if (ts.isClassDeclaration(node)) errors.push(`${pos(node)}  class declarations are forbidden`);
        if (ts.isInterfaceDeclaration(node)) errors.push(`${pos(node)}  interface declarations are forbidden`);
        if (ts.isTypeAliasDeclaration(node)) {
            const aliasName = node.name.text;
            if (aliasName !== 'FilePath' && aliasName !== 'DirPath')
                errors.push(`${pos(node)}  type alias declarations are forbidden`);
        }
        if (ts.isFunctionDeclaration(node)) {
            if (node.typeParameters?.length) errors.push(`${pos(node)} generic workflow/executor declarations are unsupported; use concrete data contracts`);
            if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) errors.push(`${pos(node)} default exports are unsupported; use a named exported workflow`);
            const isAsync = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
            const isDeclare = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword);
            if (!isAsync && node.body && ['_by_ai', '_by_human', '_by_code', '_by_sys'].some(suffix => node.name?.text.endsWith(suffix)))
                errors.push(`${pos(node)} executor declaration body is unsupported and cannot be executed; use declare function and implement the executor adapter instead`);
            if (node.asteriskToken) errors.push(`${pos(node)} generator workflow declarations are not supported`);
            const parameterNames = new Set<string>();
            for (const parameter of node.parameters) {
                if (!ts.isIdentifier(parameter.name)) {
                    errors.push(`${pos(parameter)} destructured workflow parameters are not supported`);
                } else {
                    if (parameter.name.text === 'this')
                        errors.push(`${pos(parameter)} this parameters are not supported in workflow declarations`);
                    if (parameterNames.has(parameter.name.text))
                        errors.push(`${pos(parameter)} duplicate workflow parameter '${parameter.name.text}'`);
                    parameterNames.add(parameter.name.text);
                }
                // Trailing AI skills defaults are compile-time metadata, not runtime
                // parameter binding. All other defaults remain unsupported.
                const isSkillsMetadata = isDeclare && !isAsync && !node.body &&
                    node.name?.text.endsWith('_by_ai') && node.parameters.length >= 3 &&
                    parameter === node.parameters[node.parameters.length - 1] &&
                    ts.isIdentifier(parameter.name) && parameter.name.text === 'skills' &&
                    parameter.type && ts.isArrayTypeNode(parameter.type) &&
                    parameter.type.elementType.kind === ts.SyntaxKind.StringKeyword &&
                    parameter.initializer && ts.isArrayLiteralExpression(parameter.initializer) &&
                    parameter.initializer.elements.every(ts.isStringLiteral);
                if (parameter.initializer && !isSkillsMetadata)
                    errors.push(`${pos(parameter)} default workflow parameters are not supported`);
                if (parameter.dotDotDotToken)
                    errors.push(`${pos(parameter)} rest workflow parameters are not supported`);
                // Executor declarations retain optional prefix metadata (e.g. constraints?).
                // Workflow inputs, however, have no optional/default binding in ITT v2.
                if (isAsync && parameter.questionToken)
                    errors.push(`${pos(parameter)} optional workflow parameters are not supported`);
            }
            if (!isAsync && !isDeclare) {
                errors.push(`${pos(node)} non-async functions require declare signatures; put executable logic in an async workflow or a Code adapter`);
            }
            // Reject plain declare stubs without executor suffix — use import instead
            if (isDeclare && !isAsync) {
                const fnName = node.name?.text ?? '';
                const hasExecutorSuffix = ['_by_ai', '_by_human', '_by_code'].some(s => fnName.endsWith(s));
                if (!hasExecutorSuffix) {
                    errors.push(
                        `${pos(node)}  declare function '${fnName}': use 'import' for cross-namespace intent references`,
                    );
                    return;
                }
            }
            if (isAsync) {
                // async function fnName(...): Promise<{ ... }> { ... return { ... }; }
                // → executor: 'intent' — produces both callee.itt.json (interface) and
                //   callee.itt.impl.json (CFG implementation); always takes Path One.
                // Validate: every return statement must be `return { ... }` (object literal),
                // and the function must have at least one. This allows if/else patterns where
                // both branches return, not just a trailing return at the end.

                const allReturns: ts.ReturnStatement[] = [];

                function collectReturns(stmts: ts.NodeArray<ts.Statement>): void {
                    function visit(current: ts.Node): void {
                        if (ts.isFunctionLike(current)) return;
                        if (ts.isReturnStatement(current)) {
                            allReturns.push(current);
                            return;
                        }
                        ts.forEachChild(current, visit);
                    }

                    stmts.forEach(visit);
                }

                collectReturns(node.body?.statements ?? ts.factory.createNodeArray());
                if (allReturns.length === 0) {
                    errors.push(
                        `${pos(node)} async function '${node.name?.text}' must have at least one return { ... }`,
                    );
                } else {
                    for (const ret of allReturns) {
                        if (!ret.expression) {
                            errors.push(
                                `${pos(node)} async function '${node.name?.text}' — all return statements must return an object value`,
                            );
                            break;
                        }
                    }
                }
                if (allReturns.length && node.body && !alwaysReturns(node.body)) {
                    errors.push(`${pos(node)} async function '${node.name?.text}' must return an object on every fall-through path`);
                }
                // Walk the body with the same subset rules
                node.body?.statements.forEach(s => walk(s));
                return; // prevent double-walk via generic ts.forEachChild below
            }
            const fnName = node.name?.text ?? '';
            const decl = tryExtractDeclaration(node, fnName, sourceFile, errors);
            if (decl) declarations.push(decl);
        }
        if (ts.isDoStatement(node) || ts.isForInStatement(node) || ts.isThrowStatement(node) || ts.isLabeledStatement(node) || ts.isDebuggerStatement(node))
            errors.push(`${pos(node)} ${ts.SyntaxKind[node.kind]} is not supported`);
        if ((ts.isBreakStatement(node) || ts.isContinueStatement(node)) && node.label)
            errors.push(`${pos(node)} labelled loop jumps are not supported`);
        if (ts.isForOfStatement(node) && node.awaitModifier) errors.push(`${pos(node)} for await is not supported`);
        if (ts.isTryStatement(node)) errors.push(`${pos(node)}  try/catch/throw not supported`);
        if (ts.isSwitchStatement(node)) errors.push(`${pos(node)}  switch not supported`);
        // Only named relative imports allowed (TS-native namespace: import { fn } from './ns/fn')
        if (ts.isImportDeclaration(node)) {
            const modulePath = (node.moduleSpecifier as ts.StringLiteral).text;
            const isRelative = modulePath.startsWith('./') || modulePath.startsWith('../');
            const isNamed = node.importClause?.namedBindings &&
                ts.isNamedImports(node.importClause.namedBindings);
            if (node.importClause?.name || node.attributes)
                errors.push(`${pos(node)} default imports and import attributes are unsupported; use named relative workflow imports`);
            if (!isRelative || !isNamed) {
                errors.push(
                    `${pos(node)}  only named relative imports are supported (e.g. import { fn } from './ns/fn')`,
                );
            }
            return; // don't recurse into import children
        }
        if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
            errors.push(`${pos(node)}  export not supported`);
        }
        // new Foo() except new Array(n)
        if (ts.isNewExpression(node)) {
            const expr = unwrapExpression(node.expression);
            if (!(ts.isIdentifier(expr) && expr.text === 'Array')) {
                errors.push(`${pos(node)}  new expression not supported (except new Array(n)); use _by_code/_by_sys capability instead`);
            }
        }
        // Arrow function as variable RHS
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)) {
            errors.push(`${pos(node)}  arrow function stored as variable is not supported`);
        }
        // delete / void operators
        if (ts.isDeleteExpression(node)) errors.push(`${pos(node)}  delete operator not supported`);
        if (ts.isVoidExpression(node)) errors.push(`${pos(node)}  void operator not supported`);
        // _by_sys calls: validate method name is in registry
        if (ts.isCallExpression(node)) {
            const name = directCallee(node)?.text;
            if (node.typeArguments?.length && name && (callableNames.has(name) || name.endsWith('_by_sys')))
                errors.push(`${pos(node)} generic workflow/executor calls are unsupported; remove type arguments and use concrete contracts`);
            if (name && (callableNames.has(name) || name.endsWith('_by_sys')) && !ts.isAwaitExpression(expressionConsumer(node).parent))
                errors.push(`${pos(node)} workflow calls must be directly awaited`);
            if (name && name.endsWith('_by_sys')) {
                const methodName = name.slice(0, -'_by_sys'.length);
                if (!Object.prototype.hasOwnProperty.call(systemMethods, methodName)) {
                    errors.push(`${pos(node)}  unknown _by_sys method: '${methodName}'`);
                }
            }
        }
        if (ts.isAwaitExpression(node)) {
            const root = expressionConsumer(node), parent = root.parent;
            const assignment = ts.isBinaryExpression(parent) && parent.right === root &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isExpressionStatement(expressionConsumer(parent).parent);
            const admitted = ts.isExpressionStatement(parent) || ts.isReturnStatement(parent) ||
                (ts.isVariableDeclaration(parent) && parent.initializer === root) || assignment;
            if (!awaitedCall(node) || !admitted)
                errors.push(`${pos(node)} await is supported only as a complete call in a declaration, simple assignment, return or standalone statement`);
        }

        ts.forEachChild(node, walk);
    }

    try {
        ts.forEachChild(sourceFile, walk);
    } catch (error) {
        errors.push((error as Error).message);
    }

    if (errors.length > 0) return {ok: false, errors};
    // Append sys builtins after user declarations so user declarations keep their indices
    for (const declaration of declarations) {
        const owner = [...aiSelections.keys()].find(node => node.name?.text === declaration.fnName);
        if (owner && aiSelections.has(owner)) declaration.aiSelection = aiSelections.get(owner);
    }
    return {ok: true, sourceFile, declarations: [...declarations, ...sysBuiltins]};
}

function tryExtractDeclaration(
    node: ts.FunctionDeclaration,
    fnName: string,
    sf: ts.SourceFile,
    errors: string[],
): CallDeclaration | null {
    function pos(n: ts.Node): string {
        const {line, character} = sf.getLineAndCharacterOfPosition(n.getStart());
        return `${line + 1}:${character + 1}`;
    }

    function mapInputs(params: readonly ts.ParameterDeclaration[]): { name: string; kind: ValueType }[] {
        return Array.from(params).map(p => {
            const name = (p.name as ts.Identifier).text;
            const kind = typeToValueType(p.type) as ValueType;
            return {name, kind};
        });
    }

    if (fnName.endsWith('_by_ai')) {
        const callee = fnName.slice(0, -6);
        const params = node.parameters;
        // Constraints: third param named "constraints" that is optional string[] (not a business input)
        const hasConstraints = params.length >= 3 &&
            ts.isIdentifier(params[2].name) &&
            (params[2].name as ts.Identifier).text === 'constraints' &&
            params[2].questionToken !== undefined &&
            ts.isArrayTypeNode((params[2].type as ts.TypeNode));
        const prefixCount = hasConstraints ? 3 : 2;

        // Check if last param is `skills: string[]` (with optional default)
        let skills: string[] | undefined;
        const lastParam = params[params.length - 1];
        if (
            lastParam &&
            ts.isIdentifier(lastParam.name) &&
            (lastParam.name as ts.Identifier).text === 'skills' &&
            lastParam.type &&
            ts.isArrayTypeNode(lastParam.type)
        ) {
            if (lastParam.initializer && ts.isArrayLiteralExpression(lastParam.initializer) &&
                lastParam.initializer.elements.every(ts.isStringLiteral)) {
                skills = lastParam.initializer.elements.map(el => (el as ts.StringLiteral).text);
            } else {
                skills = [];
            }
        }

        // Exclude trailing `skills` param from business inputs
        const allBusinessParams = Array.from(params).slice(prefixCount);
        const hasSkillsParam =
            allBusinessParams.length > 0 &&
            ts.isIdentifier(allBusinessParams[allBusinessParams.length - 1].name) &&
            (allBusinessParams[allBusinessParams.length - 1].name as ts.Identifier).text === 'skills';
        const businessParams = hasSkillsParam ? allBusinessParams.slice(0, -1) : allBusinessParams;
        const inputs = mapInputs(businessParams);

        const outputs = outputFields(node.type);
        return {
            fnName, executor: 'ai', callee, prefixCount,
            prefixParams: {role: '', prompt: ''} as AIPrefixParams,
            inputs, outputs, ...(skills !== undefined ? {skills} : {})
        };
    }

    if (fnName.endsWith('_by_human')) {
        const callee = fnName.slice(0, -9);
        const params = node.parameters;
        // Constraints: second param named "constraints" that is optional string[] (not a business input)
        const hasConstraints = params.length >= 2 &&
            ts.isIdentifier(params[1].name) &&
            (params[1].name as ts.Identifier).text === 'constraints' &&
            params[1].questionToken !== undefined &&
            ts.isArrayTypeNode((params[1].type as ts.TypeNode));
        const prefixCount = hasConstraints ? 2 : 1;
        const inputs = mapInputs(params.slice(prefixCount));
        const outputs = outputFields(node.type);
        return {
            fnName, executor: 'human', callee, prefixCount,
            prefixParams: {prompt: ''} as HumanPrefixParams,
            inputs, outputs
        };
    }

    if (fnName.endsWith('_by_code')) {
        const callee = fnName.slice(0, -8);
        // New format: (lang, script, inputs?: { ... })
        // Always prefixCount=2; inputs parsed from object literal at call site
        const outputs = outputFields(node.type);
        return {
            fnName, executor: 'code', callee, prefixCount: 2,
            prefixParams: {lang: 'bash'} as CodePrefixParams,
            inputs: [], outputs
        };
    }

    return null;
}

/** Conservative fall-through analysis; loops may execute zero times. */
function alwaysReturns(statement: ts.Statement): boolean {
    if (ts.isReturnStatement(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.some(alwaysReturns);
    if (ts.isIfStatement(statement)) return !!statement.elseStatement && alwaysReturns(statement.thenStatement) && alwaysReturns(statement.elseStatement);
    return false;
}

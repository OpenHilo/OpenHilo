import type { InputShape } from '@openhilo/itt-contracts/run-inputs';
import {typeToValueType, typeToInputShape} from './type-contract';
import {awaitedCall, directCallee, unwrapExpression} from './expression-forms';
// src/translator/ast-to-itt.ts
import * as ts from 'typescript';
import type {
  AssignNode,
  CallNode,
  CFGITT,
  CFGNode,
  ForeachNode,
  ForNode,
  IfNode,
  ValueType
} from '@openhilo/itt-contracts';
import {LexicalBindings} from './lexical-bindings';
import {NodeIdGen} from './node-id-gen';
import {renderBindingPattern} from './binding-pattern';
import {KEY_GUARD, policyError, RESULT_GUARD} from './expression-policy';
import type {CallDeclaration} from './ts-validator';

/** User field names are data, including names inherited from Object.prototype. */
function setOwnField<T>(record: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(record, key, {value, enumerable: true, writable: true, configurable: true});
}

// ─── Exported types ───────────────────────────────────────────────────────────

export interface FunctionSignature {
    params: { name: string; kind: ValueType }[];
    outputs: { name: string; kind: ValueType }[];
    node: ts.FunctionDeclaration;
    isPublic: boolean;   // true if function has `export` modifier
}

export interface SourceSpan {
    start: number;
    end: number;
    line: number;
    column: number
}

class CompilationContext extends NodeIdGen {
    resultVar?: string;
    readonly sourceMap: Record<string, SourceSpan> = {};

    constructor(readonly bindings: LexicalBindings, readonly returnOutputs?: ReadonlyMap<string, ValueType>) {
        super();
    }

    temporary(prefix: string): string {
        let name: string;
        do {
            name = this.next(prefix);
        } while (this.bindings.isReserved(name));
        return name;
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function astToITT(
    sourceFile: ts.SourceFile,
    declarations: CallDeclaration[],
): CFGITT {
    const gen = new CompilationContext(new LexicalBindings(sourceFile, sourceFile));
    const nodes: Record<string, CFGNode> = {};
    const typeMap = new Map<string, ValueType>();

    // Collect body statements (top-level, skipping function declarations)
    const bodyStmts: ts.Statement[] = [];
    ts.forEachChild(sourceFile, child => {
        if (ts.isFunctionDeclaration(child)) return; // these are the call signatures
        if (ts.isStatement(child)) bodyStmts.push(child as ts.Statement);
    });

    seedLocalTypes(sourceFile, typeMap, gen);
    const {firstId} = compileStatements(
        bodyStmts,
        'END',
        undefined,
        typeMap,
        gen,
        nodes,
        declarations,
        sourceFile,
    );

    // Infer name from first callee, fallback to 'workflow'
    const firstName = declarations.length > 0 ? declarations[0].callee : 'workflow';

    return {
        version: 2, expressionSemantics: 'plain-data',
        name: firstName,
        entry: firstId,
        inputs: {},
        nodes,
    };
}

// ─── Loop context ─────────────────────────────────────────────────────────────

interface LoopCtx {
    breakId: string;    // where break jumps to (loop's next_exit)
    continueId: string; // where continue jumps to (loop node itself)
}

function clearAssignments(names: string[]): AssignNode['assignments'] {
    return names.map(name => ({var: name, type: 'json', expr: 'null'}));
}

function cleanup(names: string[], next: string, gen: CompilationContext, nodes: Record<string, CFGNode>): string {
    if (!names.length) return next;
    const id = gen.next('scope_exit');
    nodes[id] = {id, type: 'assign', assignments: clearAssignments(names), next};
    return id;
}

// ─── Core compiler ────────────────────────────────────────────────────────────

function compileStatements(
    stmts: ts.Statement[],
    continuation: string,
    loopCtx: LoopCtx | undefined,
    typeMap: Map<string, ValueType>,
    gen: CompilationContext,
    nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[],
    sourceFile: ts.SourceFile,
): { firstId: string } {
    if (stmts.length === 0) {
        return {firstId: continuation};
    }

    // Process statements right-to-left so each knows its continuation
    const parent = stmts[0]?.parent;
    let currentContinuation = cleanup(parent && ts.isBlock(parent) ? gen.bindings.owned(parent) : [], continuation, gen, nodes);

    // Collect all node IDs per statement (right-to-left)
    const statementFirstIds: string[] = new Array(stmts.length);

    for (let i = stmts.length - 1; i >= 0; i--) {
        const stmt = stmts[i];
        const result = compileStatement(
            stmt,
            currentContinuation,
            loopCtx,
            typeMap,
            gen,
            nodes,
            declarations,
            sourceFile,
        );
        const start = stmt.getStart(sourceFile);
        const {line, character} = sourceFile.getLineAndCharacterOfPosition(start);
        // Descendants already own narrower spans; only annotate newly emitted parent nodes.
        for (const id of Object.keys(nodes)) if (!gen.sourceMap[id]) gen.sourceMap[id] = {
            start,
            end: stmt.getEnd(),
            line: line + 1,
            column: character + 1
        };
        statementFirstIds[i] = result.firstId;
        currentContinuation = result.firstId;
    }

    return {firstId: statementFirstIds[0]};
}

function compileStatement(
    stmt: ts.Statement,
    continuation: string,
    loopCtx: LoopCtx | undefined,
    typeMap: Map<string, ValueType>,
    gen: CompilationContext,
    nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[],
    sourceFile: ts.SourceFile,
): { firstId: string } {

    // ── break ──────────────────────────────────────────────────────────────────
    if (ts.isBreakStatement(stmt)) {
        if (!loopCtx || stmt.label) throw new Error('Unlabelled break requires an enclosing loop');
        const id = gen.next('break');
        nodes[id] = {id, type: 'assign', assignments: clearAssignments(gen.bindings.exiting(stmt)), next: 'BREAK'};
        return {firstId: id};
    }

    // ── continue ───────────────────────────────────────────────────────────────
    if (ts.isContinueStatement(stmt)) {
        if (!loopCtx || stmt.label) throw new Error('Unlabelled continue requires an enclosing loop');
        const id = gen.next('continue');
        nodes[id] = {id, type: 'assign', assignments: clearAssignments(gen.bindings.exiting(stmt)), next: 'CONTINUE'};
        return {firstId: id};
    }

    // ── let / const variable declaration ──────────────────────────────────────
    if (ts.isVariableStatement(stmt)) {
        return compileVariableStatement(
            stmt, continuation, loopCtx, typeMap, gen, nodes, declarations, sourceFile,
        );
    }

    // ── expression statement (await call or assignment) ───────────────────────
    if (ts.isExpressionStatement(stmt)) {
        const expr = unwrapParentheses(stmt.expression);

        if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const call = awaitedCall(expr.right);
            if (call) {
                const target = unwrapExpression(expr.left);
                if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
                    // Validate the original access without evaluating/read-getting its value.
                    exprText(target, sourceFile, gen.bindings);
                    if (target.flags & ts.NodeFlags.OptionalChain) throw new Error('Optional-chain assignment targets are unsupported');
                    const base = gen.temporary('__itt_target_base'), key = gen.temporary('__itt_target_key');
                    const next = compileAwaitResult(call, result => [
                        {
                            var: gen.temporary('__itt_update'),
                            type: 'json',
                            expr: `(()=>{${base}[${key}] = (${result}); return null;})()`
                        },
                        ...clearAssignments([base, key]),
                    ], continuation, typeMap, gen, nodes, declarations, sourceFile);
                    const id = gen.next('await_target');
                    nodes[id] = {
                        id, type: 'assign', assignments: [
                            {var: base, type: 'json', expr: exprText(target.expression, sourceFile, gen.bindings)},
                            {
                                var: key,
                                type: 'text',
                                expr: ts.isPropertyAccessExpression(target) ? JSON.stringify(target.name.text) : `${KEY_GUARD}(${exprText(target.argumentExpression, sourceFile, gen.bindings)})`
                            },
                        ], next: next.firstId
                    };
                    return {firstId: id};
                }
                return compileAwaitResult(call, (result, outputs) =>
                        compileBinding(target, result, 'assign', typeMap, sourceFile, gen, outputs),
                    continuation, typeMap, gen, nodes, declarations, sourceFile);
            }
        }

        // Assignment: x = expr
        if (isUpdate(expr)) {
            const id = gen.next('assign');
            nodes[id] = {
                id,
                type: 'assign',
                assignments: compileUpdates(expr, typeMap, sourceFile, gen),
                next: continuation
            };
            return {firstId: id};
        }

        // Await call with no destructuring: await fn(...)
        const standaloneCall = awaitedCall(expr);
        if (standaloneCall) {
            return compileCallNode(
                standaloneCall,
                [],
                continuation,
                typeMap,
                gen,
                nodes,
                declarations,
                sourceFile,
            );
        }

        // Evaluate for side effects, then drop the temporary result.
        const id = gen.next('assign');
        const temporary = gen.temporary('__itt_expr');
        const node: AssignNode = {
            id,
            type: 'assign',
            assignments: [{var: temporary, type: 'json', expr: `(${exprText(expr, sourceFile, gen.bindings)}, null)`}],
            next: continuation,
        };
        nodes[id] = node;
        return {firstId: id};
    }

    // ── if statement ──────────────────────────────────────────────────────────
    if (ts.isIfStatement(stmt)) {
        return compileIfStatement(
            stmt, continuation, loopCtx, typeMap, gen, nodes, declarations, sourceFile,
        );
    }

    // ── for statement (C-style) ───────────────────────────────────────────────
    if (ts.isForStatement(stmt)) {
        return compileForStatement(
            stmt, continuation, loopCtx, typeMap, gen, nodes, declarations, sourceFile,
        );
    }

    // ── for...of statement ────────────────────────────────────────────────────
    if (ts.isForOfStatement(stmt)) {
        return compileForeachStatement(
            stmt, continuation, loopCtx, typeMap, gen, nodes, declarations, sourceFile,
        );
    }

    if (ts.isWhileStatement(stmt)) {
        const id = gen.next('for');
        const body = compileStatements(blockStatements(stmt.statement), id,
            {breakId: continuation, continueId: id}, typeMap, gen, nodes, declarations, sourceFile);
        nodes[id] = {
            id, type: 'for', init: [], step: [], condition: exprText(stmt.expression, sourceFile, gen.bindings),
            next_body: body.firstId, next_exit: continuation
        };
        return {firstId: id};
    }
    if (ts.isBlock(stmt)) return compileStatements(Array.from(stmt.statements), continuation, loopCtx, typeMap, gen, nodes, declarations, sourceFile);
    if (ts.isReturnStatement(stmt)) {
        const call = stmt.expression && awaitedCall(stmt.expression);
        if (call) {
            if (!gen.returnOutputs) throw new Error('return await requires a declared workflow output contract');
            const outputKeys = [...gen.returnOutputs.keys()];
            return compileAwaitResult(call, result => returnAssignments(result, outputKeys, gen),
                'END', typeMap, gen, nodes, declarations, sourceFile);
        }
        const id = gen.next('return');
        nodes[id] = {id, ...compileReturn(stmt, sourceFile, gen)};
        return {firstId: id};
    }
    if (ts.isEmptyStatement(stmt) || ts.isImportDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) return {firstId: continuation};
    const {line, character} = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile));
    throw new Error(`${line + 1}:${character + 1} Unsupported statement: ${ts.SyntaxKind[stmt.kind]}`);
}

// ─── Variable statement (let/const) ──────────────────────────────────────────

function compileVariableStatement(
    stmt: ts.VariableStatement,
    continuation: string,
    loopCtx: LoopCtx | undefined,
    typeMap: Map<string, ValueType>,
    gen: CompilationContext,
    nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[],
    sourceFile: ts.SourceFile,
): { firstId: string } {
    const decls = stmt.declarationList.declarations;
    if (decls.length === 0) return {firstId: continuation};

    if (decls.length > 1) {
        let next = continuation;
        for (const decl of Array.from(decls).reverse()) {
            const single = ts.factory.updateVariableStatement(stmt, stmt.modifiers,
                ts.factory.updateVariableDeclarationList(stmt.declarationList, [decl]));
            next = compileVariableStatement(single, next, loopCtx, typeMap, gen, nodes, declarations, sourceFile).firstId;
        }
        return {firstId: next};
    }
    const firstDecl = decls[0];
    if (!firstDecl.initializer) throw new Error('Workflow variables require an explicit initializer; undefined is not persistable');

    const call = awaitedCall(firstDecl.initializer);
    if (call) return compileAwaitResult(call, (result, outputs) =>
            compileBinding(firstDecl.name, result, 'declare', typeMap, sourceFile, gen, outputs),
        continuation, typeMap, gen, nodes, declarations, sourceFile);

    // Regular let x: T = expr — collect into a single AssignNode
    const assignments: Array<{ var: string; type: ValueType; expr: string }> = [];

    for (const decl of decls) {
        if (!ts.isIdentifier(decl.name)) {
            assignments.push(...compileBinding(decl.name, exprText(decl.initializer!, sourceFile, gen.bindings), 'declare', typeMap, sourceFile, gen));
            continue;
        }
        const varName = gen.bindings.name(decl.name);
        const valueType = typeToValueType(decl.type);
        typeMap.set(varName, valueType);
        gen.bindings.assertStaticState(decl.initializer!);
        const initExpr = exprText(decl.initializer!, sourceFile, gen.bindings);
        assignments.push({var: varName, type: valueType, expr: initExpr});
    }

    if (assignments.length === 0) return {firstId: continuation};

    const id = gen.next('assign');
    const node: AssignNode = {id, type: 'assign', assignments, next: continuation};
    nodes[id] = node;
    return {firstId: id};
}

/** Capture once, then consume via the same binding/return machinery for every await form. */
function compileAwaitResult(
    call: ts.CallExpression, consume: (result: string, outputs: ReadonlySet<string>) => AssignNode['assignments'],
    continuation: string, types: Map<string, ValueType>, gen: CompilationContext, nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[], sf: ts.SourceFile,
): { firstId: string } {
    const name = directCallee(call)?.text;
    const declaration = declarations.find(d => d.fnName === name);
    if (!declaration) return compileCallNode(call, [], continuation, types, gen, nodes, declarations, sf);
    const keys = new Set(declaration.outputs.map(output => output.name));
    const internal = declaration.executor === 'intent';
    const resultVar = internal ? gen.temporary('__itt_call_object') : undefined;
    const captured = internal ? [] : declaration.outputs.map(output => ({
        outputName: output.name,
        localName: gen.temporary('__itt_call_result')
    }));
    const result = resultVar ?? `{${captured.map(binding => `[${JSON.stringify(binding.outputName)}]:${binding.localName}`).join(',')}}`;
    const id = gen.next('await_result');
    nodes[id] = {
        id, type: 'assign', assignments: [
            ...consume(result, keys), ...clearAssignments(resultVar ? [resultVar] : captured.map(binding => binding.localName)),
        ], next: continuation
    };
    const entry = compileCallNode(call, captured, id, types, gen, nodes, declarations, sf);
    if (resultVar) (nodes[entry.firstId] as CallNode).resultTo = resultVar;
    return entry;
}

/** One native pattern evaluation, followed by explicit scope writes and root cleanup. */
function compileBinding(
    pattern: ts.BindingName | ts.Expression, rhs: string, mode: 'declare' | 'assign',
    types: Map<string, ValueType>, sourceFile: ts.SourceFile, gen: CompilationContext, knownOwnOutputKeys?: ReadonlySet<string>,
): AssignNode['assignments'] {
    if (mode === 'declare' && ts.isIdentifier(pattern)) {
        const name = gen.bindings.name(pattern);
        types.set(name, 'json');
        return [{var: name, type: 'json', expr: rhs}];
    }
    const {
        text,
        names
    } = renderBindingPattern(pattern, mode, gen.bindings, node => exprText(node, sourceFile, gen.bindings), knownOwnOutputKeys);
    const temporary = gen.temporary('__itt_pattern');
    const binding = mode === 'declare' ? `const ${text} = (${rhs});` : `(${text} = (${rhs}));`;
    return [
        {var: temporary, type: 'json', expr: `(()=>{ "use strict"; ${binding} return [${names.join(',')}]; })()`},
        ...names.map((name, index) => {
            if (mode === 'declare') types.set(name, 'json');
            return {var: name, type: types.get(name) ?? 'json', expr: `${temporary}[${index}]`};
        }),
        ...clearAssignments([temporary]),
    ];
}

// ─── Assignment expression (x = expr) ────────────────────────────────────────

function isUpdate(expr: ts.Expression): boolean {
    return (ts.isBinaryExpression(expr) && expr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && expr.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        || ((ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) &&
            (expr.operator === ts.SyntaxKind.PlusPlusToken || expr.operator === ts.SyntaxKind.MinusMinusToken));
}

function compileUpdate(expr: ts.Expression, types: Map<string, ValueType>, sourceFile: ts.SourceFile, bindings: LexicalBindings): AssignNode['assignments'][number] {
    if (ts.isBinaryExpression(expr) && ts.isIdentifier(expr.left)) {
        bindings.assertAssignmentTarget(expr.left);
        const name = bindings.name(expr.left);
        const operator = ts.tokenToString(expr.operatorToken.kind);
        if (operator && operator.endsWith('=') && isUpdate(expr)) {
            if (operator === '=') bindings.assertStaticState(expr.right);
            const rhs = exprText(expr.right, sourceFile, bindings);
            return {
                var: name, type: types.get(name) ?? 'json',
                expr: operator === '=' ? rhs : `${name} ${operator.slice(0, -1)} (${rhs})`
            };
        }
    }
    if ((ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) && ts.isIdentifier(expr.operand) && isUpdate(expr)) {
        bindings.assertAssignmentTarget(expr.operand);
        const name = bindings.name(expr.operand);
        const operator = expr.operator === ts.SyntaxKind.PlusPlusToken ? '++' : '--';
        return {var: name, type: types.get(name) ?? 'number', expr: `((value) => ${operator}value)(${name})`};
    }
    throw new Error('Unsupported update target; use a variable, member or supported destructuring pattern');
}

function unwrapParentheses(expr: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    return expr;
}

function compileUpdates(expr: ts.Expression, types: Map<string, ValueType>, sourceFile: ts.SourceFile, gen: CompilationContext): AssignNode['assignments'] {
    expr = unwrapParentheses(expr);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken)
        return [...compileUpdates(expr.left, types, sourceFile, gen), ...compileUpdates(expr.right, types, sourceFile, gen)];
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(expr.left) || ts.isArrayLiteralExpression(expr.left)))
        return compileBinding(expr.left, exprText(expr.right, sourceFile, gen.bindings), 'assign', types, sourceFile, gen);
    const target = ts.isBinaryExpression(expr) ? expr.left :
        ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr) ? expr.operand : undefined;
    if (isUpdate(expr) && target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) {
        if (target.flags & ts.NodeFlags.OptionalChain) throw new Error('Optional-chain assignment targets are unsupported');
        // Native evaluation retains base/key/RHS order, coercion and short circuit.
        // The expression result is unused; returning null avoids retaining a root.
        if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) gen.bindings.assertStaticState(expr.right);
        const update = exprText(expr, sourceFile, gen.bindings);
        return [{
            var: gen.temporary('__itt_update'), type: 'json',
            expr: `(()=>{ "use strict"; ${update}; return null; })()`
        }];
    }
    return [compileUpdate(expr, types, sourceFile, gen.bindings)];
}

// ─── If statement ─────────────────────────────────────────────────────────────

function compileIfStatement(
    stmt: ts.IfStatement,
    continuation: string,
    loopCtx: LoopCtx | undefined,
    typeMap: Map<string, ValueType>,
    gen: CompilationContext,
    nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[],
    sourceFile: ts.SourceFile,
): { firstId: string } {
    const condition = exprText(stmt.expression, sourceFile, gen.bindings);
    const ifId = gen.next('if');

    // Compile then-branch
    const thenStmts = blockStatements(stmt.thenStatement);
    const {firstId: trueFirst} = compileStatements(
        thenStmts, continuation, loopCtx, typeMap, gen, nodes, declarations, sourceFile,
    );

    // Compile else-branch (or point to continuation if none)
    let falseFirst: string;
    if (stmt.elseStatement) {
        const elseStmts = ts.isBlock(stmt.elseStatement)
            ? Array.from(stmt.elseStatement.statements)
            : [stmt.elseStatement as ts.Statement];
        const {firstId} = compileStatements(
            elseStmts, continuation, loopCtx, typeMap, gen, nodes, declarations, sourceFile,
        );
        falseFirst = firstId;
    } else {
        falseFirst = continuation;
    }

    const ifNode: IfNode = {
        id: ifId,
        type: 'if',
        condition,
        next_true: trueFirst,
        next_false: falseFirst,
    };
    nodes[ifId] = ifNode;
    return {firstId: ifId};
}

// ─── For statement (C-style) ──────────────────────────────────────────────────

function compileForStatement(
    stmt: ts.ForStatement,
    continuation: string,
    _loopCtx: LoopCtx | undefined,
    typeMap: Map<string, ValueType>,
    gen: CompilationContext,
    nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[],
    sourceFile: ts.SourceFile,
): { firstId: string } {
    const forId = gen.next('for');
    const exitId = cleanup(gen.bindings.owned(stmt), continuation, gen, nodes);

    // Extract init
    const initEntries: Array<{ var: string; type: ValueType; expr: string }> = [];
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
        for (const decl of stmt.initializer.declarations) {
            if (!ts.isIdentifier(decl.name)) {
                if (!decl.initializer) throw new Error('for variable bindings require an explicit initializer');
                initEntries.push(...compileBinding(decl.name, exprText(decl.initializer, sourceFile, gen.bindings), 'declare', typeMap, sourceFile, gen));
                continue;
            }
            if (ts.isIdentifier(decl.name)) {
                const varName = gen.bindings.name(decl.name);
                const valueType = typeToValueType(decl.type);
                typeMap.set(varName, valueType);
                if (!decl.initializer) throw new Error('for variable bindings require an explicit initializer');
                gen.bindings.assertStaticState(decl.initializer);
                const initExpr = exprText(decl.initializer, sourceFile, gen.bindings);
                initEntries.push({var: varName, type: valueType, expr: initExpr});
            }
        }
    }

    if (stmt.initializer && !ts.isVariableDeclarationList(stmt.initializer)) initEntries.push(...compileUpdates(stmt.initializer, typeMap, sourceFile, gen));

    // Extract condition
    const condition = stmt.condition ? exprText(stmt.condition, sourceFile, gen.bindings) : 'true';

    const stepEntries = stmt.incrementor ? compileUpdates(stmt.incrementor, typeMap, sourceFile, gen) : [];

    // Compile body with loop context pointing to forId (continue) and exitId (break)
    const innerLoopCtx: LoopCtx = {breakId: exitId, continueId: forId};
    const bodyStmts = blockStatements(stmt.statement);
    const {firstId: bodyFirst} = compileStatements(
        bodyStmts, forId, innerLoopCtx, typeMap, gen, nodes, declarations, sourceFile,
    );

    const forNode: ForNode = {
        id: forId,
        type: 'for',
        init: initEntries,
        condition,
        step: stepEntries,
        next_body: bodyFirst,
        next_exit: exitId,
    };
    nodes[forId] = forNode;
    return {firstId: forId};
}

// ─── For...of statement ───────────────────────────────────────────────────────

function compileForeachStatement(
    stmt: ts.ForOfStatement,
    continuation: string,
    _loopCtx: LoopCtx | undefined,
    typeMap: Map<string, ValueType>,
    gen: CompilationContext,
    nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[],
    sourceFile: ts.SourceFile,
): { firstId: string } {
    const foreachId = gen.next('foreach');
    const exitId = cleanup(gen.bindings.owned(stmt), continuation, gen, nodes);

    // A destructured binding names elements of each value, never the loop cursor.
    const initializer = stmt.initializer;
    if (stmt.awaitModifier) throw new Error('for await is not supported');
    if (!ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1)
        throw new Error('for-of requires one let/const binding declaration');
    const decl = initializer.declarations[0];
    if (decl.initializer) throw new Error('for-of binding declarations cannot have an initializer');
    const destructured = !ts.isIdentifier(decl.name);
    const itemVar = ts.isIdentifier(decl.name) ? gen.bindings.name(decl.name) : gen.temporary('__itt_foreach_item');

    // Extract array expression
    const arrayExpr = exprText(stmt.expression, sourceFile, gen.bindings);

    // Compile body with loop context
    const innerLoopCtx: LoopCtx = {breakId: exitId, continueId: foreachId};
    const bodyStmts = blockStatements(stmt.statement);
    const {firstId: bodyFirst} = compileStatements(
        bodyStmts, foreachId, innerLoopCtx, typeMap, gen, nodes, declarations, sourceFile,
    );

    let nextBody = bodyFirst;
    if (destructured) {
        const id = gen.next('foreach_binding');
        nodes[id] = {
            id, type: 'assign', assignments: [
                ...compileBinding(decl.name, itemVar, 'declare', typeMap, sourceFile, gen),
                ...clearAssignments([itemVar]),
            ], next: bodyFirst
        };
        nextBody = id;
    }

    const foreachNode: ForeachNode = {
        id: foreachId,
        type: 'foreach',
        array_expr: arrayExpr,
        item_var: itemVar,
        next_body: nextBody,
        next_exit: exitId,
    };
    nodes[foreachId] = foreachNode;
    return {firstId: foreachId};
}

// ─── Call node ────────────────────────────────────────────────────────────────

interface DestructuredBinding {
    outputName: string; // the output field key from the function signature
    localName: string;  // the local variable name in the TS code
}

function compileCallNode(
    callExpr: ts.CallExpression,
    destructuredBindings: DestructuredBinding[],
    continuation: string,
    typeMap: Map<string, ValueType>,
    gen: CompilationContext,
    nodes: Record<string, CFGNode>,
    declarations: CallDeclaration[],
    sourceFile: ts.SourceFile,
): { firstId: string } {
    const calleeIdentifier = directCallee(callExpr);
    if (calleeIdentifier) gen.bindings.assertCallable(calleeIdentifier);
    const calleeName = calleeIdentifier?.text ?? callExpr.expression.getText(sourceFile);

    // Find the declaration
    const decl = declarations.find(d => d.fnName === calleeName);
    if (!decl) {
        const known = declarations.map(d => d.fnName).join(', ');
        throw new Error(
            `Unknown function call: '${calleeName}' is not a declared executor-suffix function or local async function.\n` +
            `Known callables: ${known || '(none)'}.\n` +
            `Hint: sync helper functions are not supported — use an async function (becomes a sub-intent), ` +
            `a _by_code executor, or inline the logic as an assign expression.`,
        );
    }

    const args = callExpr.arguments;
    const {executor, callee, prefixCount, inputs, outputs} = decl;
    const requiredPrefix = executor === 'ai' || executor === 'code' ? 2 : executor === 'human' ? 1 : 0;
    if (args.length < requiredPrefix) policyError(callExpr, sourceFile, `Call '${calleeName}' requires ${requiredPrefix} prefix arguments`);
    if (args.some(ts.isSpreadElement)) policyError(callExpr, sourceFile, 'Spread call arguments are unsupported; pass each declared input explicitly');

    // Build outputs map from declaration
    const outputsMap: Record<string, ValueType> = {};
    for (const o of outputs) {
        setOwnField(outputsMap, o.name, o.kind);
    }

    // Build outputsTo map from destructured bindings + seed typeMap
    const outputsTo: Record<string, string> = {};
    for (const binding of destructuredBindings) {
        setOwnField(outputsTo, binding.outputName, binding.localName);
        // Seed typeMap from declaration outputs
        const declOut = outputs.find(o => o.name === binding.outputName);
        if (declOut) {
            typeMap.set(binding.localName, declOut.kind);
        }
    }

    // Build inputs map from declaration
    const inputsMap: Record<string, { kind: ValueType }> = {};
    for (const inp of inputs) {
        setOwnField(inputsMap, inp.name, {kind: inp.kind});
    }

    // Extract prefix args by position
    const prefixArgs = Array.from(args).slice(0, prefixCount);
    const callArgs = Array.from(args).slice(prefixCount);

    if (executor !== 'code' && callArgs.length !== inputs.length)
        policyError(callExpr, sourceFile, `Call '${calleeName}' requires ${inputs.length} business arguments; received ${callArgs.length}`);
    const callId = gen.nextCall(callee);

    // Map call-specific args to inputsFrom
    const inputsFrom: Record<string, string> = {};

    for (let i = 0; i < callArgs.length && i < inputs.length; i++) {
        const arg = callArgs[i];
        exprText(arg, sourceFile, gen.bindings);
        gen.bindings.assertStaticState(arg);
        const paramName = inputs[i].name;

        if (ts.isIdentifier(arg)) {
            setOwnField(inputsFrom, paramName, `$${gen.bindings.name(arg)}`);
        } else {
            // Complex expression: put expression string (TS-only syntax stripped) into inputsFrom
            setOwnField(inputsFrom, paramName, exprText(arg, sourceFile, gen.bindings));
        }
    }

    // Build the call node
    const callNode: CallNode = {
        id: callId,
        type: 'call',
        executor,
        callee,
        inputsFrom,
        outputsTo,
        on_failure: 'ABORT',
        next: continuation,
    };

    // Apply prefix params based on executor type
    if (executor === 'ai') {
        const shapes = outputs.filter(output => output.shape !== undefined);
        if (shapes.length) callNode.outputShapes = Object.fromEntries(shapes.map(output => [output.name, output.shape!]));
        if (decl.aiSelection !== undefined) callNode.aiSelection = {...decl.aiSelection};
        if (prefixArgs[0]) callNode.role = extractStringLiteral(prefixArgs[0], sourceFile);
        if (prefixArgs[1]) callNode.intent = extractStringLiteral(prefixArgs[1], sourceFile);
        if (prefixCount >= 3 && prefixArgs[2]) {
            callNode.constraints = extractArrayLiteral(prefixArgs[2], sourceFile);
        }
        if (Object.keys(outputsMap).length > 0) callNode.outputs = outputsMap;
        if (Object.keys(inputsMap).length > 0) callNode.inputs = inputsMap;
        if (decl.skills && decl.skills.length > 0) callNode.skills = decl.skills;
    } else if (executor === 'human') {
        if (prefixArgs[0]) callNode.intent = extractStringLiteral(prefixArgs[0], sourceFile);
        if (prefixCount >= 2 && prefixArgs[1]) {
            callNode.constraints = extractArrayLiteral(prefixArgs[1], sourceFile);
        }
        if (Object.keys(outputsMap).length > 0) callNode.outputs = outputsMap;
        if (Object.keys(inputsMap).length > 0) callNode.inputs = inputsMap;
    } else if (executor === 'code') {
        // prefix: lang (arg 0), script (arg 1) — always prefixCount=2
        if (prefixArgs[0]) callNode.lang = extractStringLiteral(prefixArgs[0], sourceFile) || 'bash';
        if (prefixArgs[1]) callNode.script = extractStringLiteral(prefixArgs[1], sourceFile);

        // Build inputsFrom from optional inputs object literal (3rd arg)
        // e.g. await step_by_code('bash', `...`, { dir: projectDir, limit: maxCount })
        // → inputsFrom: { dir: '$projectDir', limit: '$maxCount' }
        const codeInputsFrom: Record<string, string> = {};
        const codeInputsMap: Record<string, { kind: ValueType }> = {};
        const inputsArg = callArgs[0];
        if (callArgs.length > 1 || (inputsArg && !ts.isObjectLiteralExpression(inputsArg))) {
            throw new Error('Code inputs must be one object literal after lang/script, e.g. { items: data }; positional values are unsupported');
        }
        if (inputsArg && ts.isObjectLiteralExpression(inputsArg)) {
            for (const prop of inputsArg.properties) {
                if ((!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) || !ts.isIdentifier(prop.name)) {
                    throw new Error('Code inputs require named identifier properties, e.g. { items: data }; spread, methods and computed/quoted keys are unsupported');
                }
                const key = prop.name.text;
                if (ts.isShorthandPropertyAssignment(prop)) {
                    exprText(prop.name, sourceFile, gen.bindings);
                    // { srcDir } shorthand — varName === key
                    setOwnField(codeInputsFrom, key, `$${gen.bindings.name(prop.name)}`);
                    setOwnField(codeInputsMap, key, {kind: typeMap.get(gen.bindings.name(prop.name)) ?? 'json'});
                } else if (ts.isPropertyAssignment(prop)) {
                    exprText(prop.initializer, sourceFile, gen.bindings);
                    gen.bindings.assertStaticState(prop.initializer);
                    if (ts.isIdentifier(prop.initializer)) {
                        const varName = gen.bindings.name(prop.initializer);
                        setOwnField(codeInputsFrom, key, `$${varName}`);
                        setOwnField(codeInputsMap, key, {kind: typeMap.get(varName) ?? 'json'});
                    } else {
                        // Complex expression: store expression text (TS-only syntax stripped)
                        setOwnField(codeInputsFrom, key, exprText(prop.initializer, sourceFile, gen.bindings));
                        setOwnField(codeInputsMap, key, {kind: 'json'});
                    }
                }
            }
        }
        callNode.inputsFrom = codeInputsFrom;

        // stdout/stderr/exit_code are always produced by the Code executor; declarations
        // may name them for typed access, but they are not script-assigned outputs.
        const CODE_RESERVED = new Set(['stdout', 'stderr', 'exit_code']);
        for (const key of CODE_RESERVED) delete outputsMap[key];
        if (Object.keys(outputsMap).length > 0) callNode.outputs = outputsMap;
        if (Object.keys(codeInputsMap).length > 0) callNode.inputs = codeInputsMap;
    } else if (executor === 'intent') {
        // intent calls: plain async function calls in TS (no _by_xxx suffix).
        // Each callee has both callee.itt.json (interface) and callee.itt.impl.json (CFG).
        // Scheduler always routes these via Path One (scope-isolated sub-ITT execution).
        if (Object.keys(outputsMap).length > 0) callNode.outputs = outputsMap;
        if (Object.keys(inputsMap).length > 0) callNode.inputs = inputsMap;
    } else if (executor === 'sys') {
        // sys: no prefix args; all call args are data inputs (prefixCount=0)
        if (Object.keys(outputsMap).length > 0) callNode.outputs = outputsMap;
        if (Object.keys(inputsMap).length > 0) callNode.inputs = inputsMap;
    }

    nodes[callId] = callNode;

    return {firstId: callId};
}

// ─── compileFunctionBody helpers ─────────────────────────────────────────────

function compileReturn(
    stmt: ts.ReturnStatement,
    sourceFile: ts.SourceFile,
    context: CompilationContext,
): Omit<AssignNode, 'id'> {
    const sourceExpr = stmt.expression;
    if (!sourceExpr && !context.returnOutputs) return {type: 'assign', assignments: [], next: 'END'};
    if (!sourceExpr) throw new Error('return statement must return an object literal or object variable');
    const expr = unwrapExpression(sourceExpr);
    if (ts.isArrayLiteralExpression(expr) || ts.isLiteralExpression(expr) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(expr.kind))
        throw new Error('Workflow return must be an object with the declared output fields');
    context.bindings.assertStaticState(expr);
    const literalKeys: string[] = [];
    if (ts.isObjectLiteralExpression(expr) && expr.properties.every(prop => (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)))) {
        for (const prop of expr.properties) {
            if ((!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) ||
                (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)))
                throw new Error('return fields must be explicit named properties; spread, methods and computed keys are unsupported');
            const key = prop.name.text;
            if (literalKeys.includes(key) || key === '__proto__') throw new Error(`Invalid or duplicate return field: ${key}`);
            literalKeys.push(key);
        }
        if (context.returnOutputs && (literalKeys.length !== context.returnOutputs.size || literalKeys.some(key => !context.returnOutputs!.has(key))))
            throw new Error('return fields must exactly match the declared outputs');
    } else if (!context.returnOutputs) {
        throw new Error('Returning an object variable requires a declared workflow output contract');
    }
    const keys = context.returnOutputs ? [...context.returnOutputs.keys()] : literalKeys;
    if (keys.includes('__proto__')) throw new Error('Invalid return field: __proto__');
    return {
        type: 'assign',
        assignments: returnAssignments(exprText(sourceExpr, sourceFile, context.bindings), keys, context),
        next: 'END'
    };
}

function returnAssignments(expression: string, keys: string[], context: CompilationContext): AssignNode['assignments'] {
    // Evaluate once and retain the whole object until the frame returns.
    const temporary = context.resultVar ?? context.temporary('__itt_return');
    return [
        {var: temporary, type: 'json', expr: `${RESULT_GUARD}(${expression}, ${JSON.stringify(keys)})`},
        ...keys.map(key => ({
            var: key,
            type: context.returnOutputs?.get(key) ?? 'json' as ValueType,
            expr: `${temporary}[${JSON.stringify(key)}]`
        })),
        ...(context.resultVar ? [] : clearAssignments([temporary])),
    ];
}

// ─── compileFunctionBody (exported) ──────────────────────────────────────────

export function compileFunctionBody(
    fn: ts.FunctionDeclaration,
    sourceFile: ts.SourceFile,
    decls: CallDeclaration[],
    registry: Map<string, FunctionSignature>,
    declaredOutputs: { name: string; kind: ValueType }[],
    nsPath: string = '',
    importMap: Map<string, string> = new Map(),
): {
    entry: string;
    nodes: Record<string, CFGNode>;
    inputs: { name: string; kind: ValueType; shape?: InputShape }[];
    outputs: { name: string; kind: ValueType }[];
    sourceMap: Record<string, SourceSpan>;
    resultVar: string;
} {
    // Extract input params from function signature
    const inputs: { name: string; kind: ValueType; shape?: InputShape }[] = (fn.parameters ?? []).map(p => ({
        name: (p.name as ts.Identifier).text,
        kind: typeToValueType(p.type),
        shape: typeToInputShape(p.type),
    }));

    // For inter-intent calls: add registry entries as CallDeclarations with executor:'intent'.
    // importMap takes precedence (cross-namespace imports); otherwise qualify with nsPath.
    const intentDecls: CallDeclaration[] = [];
    for (const [name, sig] of registry) {
        const callee = importMap.get(name) ?? (nsPath ? `${nsPath}.${name}` : name);
        intentDecls.push({
            fnName: name,
            executor: 'intent',
            callee,
            prefixCount: 0,
            prefixParams: {} as import('./ts-validator').AIPrefixParams,
            inputs: sig.params,
            outputs: sig.outputs,
        });
    }
    const allDecls = [...decls, ...intentDecls];

    // Compile body statements using the existing compileStatements function
    const bodyStatements = fn.body ? Array.from(fn.body.statements) : [];

    const gen = new CompilationContext(new LexicalBindings(sourceFile, fn.body!), new Map(declaredOutputs.map(output => [output.name, output.kind])));
    gen.resultVar = gen.temporary('__itt_return_object');
    const nodes: Record<string, CFGNode> = {};
    const typeMap = new Map<string, ValueType>(inputs.map(input => [input.name, input.kind]));
    seedLocalTypes(fn.body!, typeMap, gen);
    const {firstId} = compileStatements(bodyStatements, 'END', undefined, typeMap, gen, nodes, allDecls, sourceFile);

    return {
        entry: firstId,
        nodes,
        inputs,
        outputs: declaredOutputs,
        sourceMap: gen.sourceMap,
        resultVar: gen.resultVar,
    };
}

/** CFG construction walks backwards; declaration annotations must be known first. */
function seedLocalTypes(root: ts.Node, types: Map<string, ValueType>, gen: CompilationContext): void {
    const visit = (node: ts.Node): void => {
        if (node !== root && ts.isFunctionLike(node)) return;
        if (ts.isVariableDeclaration(node)) {
            const kind = typeToValueType(node.type);
            if (ts.isIdentifier(node.name)) types.set(gen.bindings.name(node.name), kind);
        }
        ts.forEachChild(node, visit);
    };
    visit(root);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function blockStatements(stmt: ts.Statement): ts.Statement[] {
    if (ts.isBlock(stmt)) return Array.from(stmt.statements);
    return [stmt];
}

/**
 * Get expression text with TypeScript-only syntax stripped.
 * Type assertions (`as T`, `<T>`, `satisfies T`) and non-null assertions (`x!`)
 * are valid TS but invalid JS — the eval engine runs plain JS, so we strip them.
 */
function exprText(node: ts.Expression, sf: ts.SourceFile, bindings: LexicalBindings): string {
    // Keep plain JS text stable, but inspect the entire expression: assertions can
    // occur inside return objects, call arguments, conditions and inline callbacks.
    function hasTypes(current: ts.Node): boolean {
        return ts.isTypeNode(current) || ts.isTypeParameterDeclaration(current) ||
            ts.isNonNullExpression(current) ||
            (ts.isParameter(current) && (!!current.questionToken ||
                (ts.isIdentifier(current.name) && current.name.text === 'this'))) ||
            !!ts.forEachChild(current, child => hasTypes(child) || undefined);
    }

    const original = bindings.expression(node);
    if (!hasTypes(node)) return original;

    // Use the public TypeScript emitter for nested type erasure rather than text
    // replacement. ESNext preserves JS evaluation order and requires no lowering
    // helpers. The wrapper makes object literals unambiguous expression syntax.
    const emitted = ts.transpileModule(`const __itt_expression = (${original}\n);`, {
        compilerOptions: {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext},
        reportDiagnostics: true,
    });
    if (emitted.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error))
        throw new Error('Expression cannot be emitted as JavaScript');
    const parsed = ts.createSourceFile('expression.js', emitted.outputText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    // Runtime owns strict evaluation; TypeScript 6's leading directive is not
    // part of the expression. All other extra statements remain forbidden.
    const first = parsed.statements[0];
    const statements = first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use strict'
        ? parsed.statements.slice(1) : parsed.statements;
    const statement = statements[0];
    if (statements.length !== 1 || !statement || !ts.isVariableStatement(statement) ||
        statement.declarationList.declarations.length !== 1)
        throw new Error('Expression requires unsupported JavaScript helper statements');
    const initializer = statement.declarationList.declarations[0].initializer;
    if (!initializer)
        throw new Error('Expression cannot be emitted as a standalone JavaScript expression');
    return (ts.isParenthesizedExpression(initializer) ? initializer.expression : initializer).getText(parsed);
}

function extractStringLiteral(node: ts.Expression, sourceFile: ts.SourceFile): string {
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    throw new Error(`Executor prefix arguments must be string literals without interpolation; received ${node.getText(sourceFile)}. Pass dynamic values as business inputs after the prefix arguments.`);
}

function extractArrayLiteral(node: ts.Expression, sourceFile: ts.SourceFile): string[] {
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.map(el => extractStringLiteral(el, sourceFile));
    }
    throw new Error(`Executor constraints must be an array literal of string literals; received ${node.getText(sourceFile)}. Pass dynamic values as business inputs after the prefix arguments.`);
}

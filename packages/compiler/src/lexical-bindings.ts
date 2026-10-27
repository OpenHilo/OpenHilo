import * as ts from 'typescript';
import {guardOptionalExpression} from './guarded-expression';
import {
  assertStaticState,
  expressionConsumer,
  isDirectCallTarget,
  KEY_GUARD,
  policyError,
  RESULT_GUARD,
  validateExpressionSyntax,
  validateGlobalUse,
  VALUE_GLOBALS,
  VALUE_GUARD
} from './expression-policy';

const expressionGlobals = new Set('Math JSON Array Object String Number Boolean parseInt parseFloat isNaN isFinite undefined NaN Infinity Date RegExp Map Set WeakMap WeakSet Promise Symbol BigInt'.split(' '));

const analyses = new WeakMap<ts.SourceFile, { checker: ts.TypeChecker; used: ReadonlySet<string> }>();

/** File-level binding analysis shared by every function compiled from the same source. */
function analyze(source: ts.SourceFile): { checker: ts.TypeChecker; used: ReadonlySet<string> } {
    const cached = analyses.get(source);
    if (cached) return cached;
    // A closed, in-memory program: binding does not require lib files, imports or filesystem I/O.
    const files = new Map([[source.fileName, source]]);
    const program = ts.createProgram([...files.keys()], {
        noLib: true,
        noResolve: true,
        target: ts.ScriptTarget.ESNext
    }, {
        getSourceFile: name => files.get(name),
        getDefaultLibFileName: () => '', writeFile() {
        }, getCurrentDirectory: () => '',
        getDirectories: () => [], fileExists: name => files.has(name),
        readFile: name => files.get(name)?.text,
        getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    });
    const checker = program.getTypeChecker();
    // Only lexical correctness, not a claim of complete TypeScript typechecking.
    const lexicalErrors = new Set([2448, 2451, 2588]);
    for (const diagnostic of program.getSemanticDiagnostics(source)) {
        if (lexicalErrors.has(diagnostic.code)) {
            const {line, character} = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
            throw new Error(`${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
        }
    }
    const used = new Set<string>();
    const identifiers = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) used.add(node.text);
        ts.forEachChild(node, identifiers);
    };
    identifiers(source);
    for (const reserved of [KEY_GUARD, VALUE_GUARD, RESULT_GUARD]) if (used.has(reserved)) policyError(source, source, `Reserved compiler identifier ${reserved}`);
    const analysis = {checker, used};
    analyses.set(source, analysis);
    return analysis;
}

/** Resolve source bindings without changing the ITT v2 format or source positions. */
export class LexicalBindings {
    private readonly checker: ts.TypeChecker;
    private readonly names = new Map<ts.Symbol, string>();
    private readonly locals = new Map<ts.Node, string[]>();
    private readonly declaredNames = new Set<string>();
    private readonly used: Set<string>;
    private sequence = 0;

    constructor(private readonly source: ts.SourceFile, private readonly root: ts.Node) {
        const analysis = analyze(source);
        this.checker = analysis.checker;
        this.used = new Set(analysis.used);
        const checkBindingName = (name: ts.Identifier): void => {
            if (VALUE_GLOBALS.has(name.text)) policyError(name, source, `Reserved immutable VM constant '${name.text}' cannot be a workflow binding`);
        };
        if (ts.isFunctionLike(root.parent)) for (const parameter of root.parent.parameters) {
            if (ts.isIdentifier(parameter.name)) checkBindingName(parameter.name);
        }
        const collect = (node: ts.Node): void => {
            if (node !== root && ts.isFunctionLike(node)) return; // inline callbacks retain native JS scopes
            if (ts.isVariableDeclaration(node)) {
                let owner: ts.Node | undefined = node.parent;
                while (owner && !ts.isBlock(owner) && !ts.isForStatement(owner) && !ts.isForOfStatement(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
                const bind = (name: ts.BindingName): void => {
                    if (!ts.isIdentifier(name)) {
                        for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
                        return;
                    }
                    checkBindingName(name);
                    this.declaredNames.add(name.text);
                    if (!owner || owner === root) return;
                    const symbol = this.checker.getSymbolAtLocation(name);
                    if (!symbol) throw new Error(`Cannot resolve declaration '${name.text}'`);
                    let unique: string;
                    do {
                        unique = `__hilo_local_${++this.sequence}_${name.text}`;
                    } while (this.used.has(unique));
                    this.used.add(unique);
                    this.names.set(symbol, unique);
                    this.locals.set(owner, [...(this.locals.get(owner) ?? []), unique]);
                };
                bind(node.name);
            }
            ts.forEachChild(node, collect);
        };
        collect(root);
    }

    name(node: ts.Identifier): string {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
            ? this.checker.getShorthandAssignmentValueSymbol(node.parent) : this.checker.getSymbolAtLocation(node);
        this.checkReference(node, symbol);
        return this.names.get(symbol!) ?? node.text;
    }

    assertCallable(node: ts.Identifier): void {
        const symbol = this.checker.getSymbolAtLocation(node);
        this.checkReference(node, symbol);
        if (symbol?.declarations?.some(declaration => ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration) || ts.isParameter(declaration)))
            throw new Error(`Callable '${node.text}' is shadowed by a local variable or parameter`);
    }

    assertAssignmentTarget(node: ts.Identifier): void {
        if (!this.isWorkflowBinding(node)) policyError(node, this.source, `Assignment target '${node.text}' must be a declared workflow variable`);
    }

    isReserved(name: string): boolean {
        return this.used.has(name);
    }

    owned(node: ts.Node | undefined): string[] {
        return node ? this.locals.get(node) ?? [] : [];
    }

    exiting(node: ts.Node): string[] {
        const names: string[] = [];
        for (let parent = node.parent; parent && parent !== this.root; parent = parent.parent) {
            if (ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isWhileStatement(parent)) break;
            names.push(...this.owned(parent));
        }
        return names;
    }

    assertStaticState(node: ts.Expression): void {
        assertStaticState(node, this.source, identifier => !this.checker.getSymbolAtLocation(identifier)?.declarations?.length);
    }

    expression(node: ts.Expression): string {
        validateExpressionSyntax(node, this.source);
        const containsChain = (current: ts.Node): boolean => !ts.isTypeNode(current) &&
            (ts.isOptionalChain(current) || !!ts.forEachChild(current, child => containsChain(child) || undefined));
        const optional = containsChain(node);
        const edits: Array<{ start: number; end: number; text: string }> = [];
        const start = node.getStart(this.source);
        const visit = (current: ts.Node): void => {
            if (ts.isTypeNode(current) || ts.isTypeParameterDeclaration(current)) return;
            // transpileModule can lower invalid optional writes without a diagnostic.
            // Check original write positions before lowering, including callback patterns.
            if (ts.isOptionalChain(current) && this.isWritePosition(current))
                policyError(current, this.source, 'Optional-chain assignment/update targets are unsupported');
            const update = ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment
                ? current.left : (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) &&
                (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken) ? current.operand : undefined;
            const loopTarget = (ts.isForOfStatement(current) || ts.isForInStatement(current)) && !ts.isVariableDeclarationList(current.initializer) ? current.initializer : undefined;
            const target = (update || loopTarget) && this.workflowAssignmentTarget((update || loopTarget)!);
            if (target) throw new Error(`Update to workflow variable '${target.text}' inside an expression is unsupported; use a separate assignment statement`);
            // Function-valued reads must not escape through inherited native methods or
            // callback-local destructuring aliases. Direct calls retain their receiver.
            if (!optional && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) && !this.isWritePosition(current) && !isDirectCallTarget(current)) {
                edits.push({
                        start: current.getStart(this.source) - start,
                        end: current.getStart(this.source) - start,
                        text: `${VALUE_GUARD}(`
                    },
                    {start: current.getEnd() - start, end: current.getEnd() - start, text: ')'});
            }
            if (ts.isElementAccessExpression(current) && !ts.isStringLiteralLike(current.argumentExpression) && !ts.isNumericLiteral(current.argumentExpression)) {
                const key = current.argumentExpression;
                edits.push({
                        start: key.getStart(this.source) - start,
                        end: key.getStart(this.source) - start,
                        text: `${KEY_GUARD}(`
                    },
                    {start: key.getEnd() - start, end: key.getEnd() - start, text: ')'});
            }
            if (ts.isIdentifier(current)) {
                const parent = current.parent;
                const shorthand = ts.isShorthandPropertyAssignment(parent) && parent.name === current;
                const property = (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
                    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === current) ||
                    (ts.isBindingElement(parent) && parent.propertyName === current);
                if (property) return;
                const symbol = shorthand ? this.checker.getShorthandAssignmentValueSymbol(parent) : this.checker.getSymbolAtLocation(current);
                this.checkReference(current, symbol);
                if (!symbol?.declarations?.length) validateGlobalUse(current, this.source);
                if (symbol?.declarations?.some(d => ts.isFunctionDeclaration(d) || ts.isImportSpecifier(d)))
                    policyError(current, this.source, `Workflow callable ${current.text} must be invoked directly with await, not used as a value`);
                const self = symbol?.declarations?.some(d => ts.isFunctionExpression(d));
                if (self && !(ts.isFunctionExpression(parent) && parent.name === current) && !isDirectCallTarget(current))
                    policyError(current, this.source, 'Named callback self references support direct invocation only, not function values');
                const name = symbol && this.names.get(symbol);
                const guard = !!symbol?.valueDeclaration && !this.isWritePosition(current) && !self;
                if (name || guard) edits.push({
                    start: current.getStart(this.source) - start, end: current.getEnd() - start,
                    text: shorthand ? `${current.text}: ${guard ? `${VALUE_GUARD}(${name ?? current.text})` : name}` : guard ? `${VALUE_GUARD}(${name ?? current.text})` : name!
                });
            }
            ts.forEachChild(current, visit);
        };
        visit(node);
        let text = node.getText(this.source);
        for (const edit of edits.map((edit, order) => ({
            ...edit,
            order
        })).sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        return optional ? guardOptionalExpression(text, member => !this.isWritePosition(member) && !isDirectCallTarget(member)) : text;
    }

    private checkReference(node: ts.Identifier, symbol: ts.Symbol | undefined): void {
        if (!symbol && this.declaredNames.has(node.text) && !expressionGlobals.has(node.text)) policyError(node, this.source, `Variable '${node.text}' is outside its lexical scope`);
    }

    private isWorkflowBinding(node: ts.Identifier): boolean {
        const symbol = ts.isShorthandPropertyAssignment(node.parent) ? this.checker.getShorthandAssignmentValueSymbol(node.parent) : this.checker.getSymbolAtLocation(node);
        const declaration = symbol?.valueDeclaration;
        if (!declaration) return false;
        for (let parent: ts.Node | undefined = declaration; parent; parent = parent.parent) {
            if (parent === this.root || parent === this.root.parent) return true;
            if (ts.isFunctionLike(parent)) return false;
        }
        return false;
    }

    private workflowAssignmentTarget(node: ts.Node): ts.Identifier | undefined {
        if (ts.isIdentifier(node)) return this.isWorkflowBinding(node) ? node : undefined;
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))
            return this.workflowAssignmentTarget(node.expression);
        if (ts.isArrayLiteralExpression(node)) {
            for (const element of node.elements) {
                const target = this.workflowAssignmentTarget(element);
                if (target) return target;
            }
        }
        if (ts.isObjectLiteralExpression(node)) {
            for (const property of node.properties) {
                const target = this.workflowAssignmentTarget(ts.isPropertyAssignment(property) ? property.initializer :
                    ts.isShorthandPropertyAssignment(property) ? property.name : property);
                if (target) return target;
            }
        }
        if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return this.workflowAssignmentTarget(node.expression);
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return this.workflowAssignmentTarget(node.left);
        return undefined;
    }

    /** A write/binding occurrence is not a value read; wrapping it would change JS grammar. */
    private isWritePosition(node: ts.Node): boolean {
        const parent = node.parent;
        if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionExpression(parent)) && parent.name === node) return true;
        let target = expressionConsumer(node);
        for (; ;) {
            const p = target.parent;
            if (ts.isBinaryExpression(p) && p.left === target && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
            if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && p.operand === target && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator)) return true;
            if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === target) return true;
            if (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) ||
                (ts.isShorthandPropertyAssignment(p) && p.name === target) || (ts.isPropertyAssignment(p) && p.initializer === target)) target = expressionConsumer(p);
            else return false;
        }
    }
}

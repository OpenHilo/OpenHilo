import * as ts from 'typescript';
import {parseAiSelection, type AiSelection} from '@openhilo/itt-contracts/ai-selection';

/** Scan actual comment tokens, never strings/templates; use AST ranges for attachment. */
export function readAiSelections(sf: ts.SourceFile, errors: string[]): Map<ts.FunctionDeclaration, AiSelection> {
    const declarations: ts.FunctionDeclaration[] = [];
    const collect = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node)) declarations.push(node);
        ts.forEachChild(node, collect);
    };
    collect(sf);
    const result = new Map<ts.FunctionDeclaration, AiSelection>();
    // SourceFile comment ranges are safer than a standalone scanner around templates/regex.
    const comments = new Map<number, ts.CommentRange>();
    const collectComments = (node: ts.Node): void => {
        for (const range of ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? []) comments.set(range.pos, range);
        for (const range of ts.getTrailingCommentRanges(sf.text, node.getFullStart()) ?? []) comments.set(range.pos, range);
        for (const range of ts.getTrailingCommentRanges(sf.text, node.end) ?? []) comments.set(range.pos, range);
        ts.forEachChild(node, collectComments);
    };
    collectComments(sf);
    for (const range of comments.values()) {
        const text = sf.text.slice(range.pos, range.end);
        if (!text.startsWith('/**')) continue;
        const doc = ts.createSourceFile('annotation.ts', `${text}\ndeclare function metadata(): void;`, ts.ScriptTarget.Latest, true);
        const tags = ts.getJSDocTags(doc.statements[0]).filter(tag => tag.tagName.text === 'ai' || tag.tagName.text.startsWith('ai.'));
        if (!tags.length) continue;
        const owner = declarations.find(node => node.getFullStart() <= range.pos && node.getStart(sf) >= range.end);
        const position = sf.getLineAndCharacterOfPosition(range.pos);
        const prefix = `${position.line + 1}:${position.character + 1} AI selection`;
        if (!owner || !owner.name?.text.endsWith('_by_ai') || owner.body ||
            !owner.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword) ||
            owner.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            errors.push(`${prefix}: @ai tags belong only on declare function ..._by_ai`);
            continue;
        }
        const selection: Record<string, unknown> = {...result.get(owner)};
        for (const tag of tags) {
            const raw = tag.getText(doc).replace(/\s*\*\s*/g, ' ').trim();
            const match = /^@ai\.(type|level)\s+(\S+)\s*$/.exec(raw);
            if (!match) { errors.push(`${prefix}: invalid @ai tag; use @ai.type VALUE or @ai.level VALUE`); continue; }
            const [, key, value] = match;
            if (Object.hasOwn(selection, key)) errors.push(`${prefix}: duplicate @ai.${key}`);
            selection[key] = value;
        }
        try { result.set(owner, parseAiSelection(selection)); }
        catch (error) { errors.push(`${prefix}: ${(error as Error).message}`); }
    }
    return result;
}

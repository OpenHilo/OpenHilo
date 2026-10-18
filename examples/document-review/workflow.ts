type FilePath = string;
type DirPath = string;

declare function draft_document_by_ai(role: string, prompt: string, brief: FilePath, references: DirPath): Promise<{ document: FilePath }>;

declare function revise_document_by_ai(role: string, prompt: string, brief: FilePath, references: DirPath, document: FilePath, feedback: string): Promise<{
    document: FilePath
}>;

declare function review_document_by_human(prompt: string, document: FilePath, preview: string, revision: number): Promise<{
    finished: boolean;
    feedback: string
}>;

declare function inspect_document_by_code(lang: string, script: string, inputs: { document: FilePath }): Promise<{
    preview: string;
    bytes: number;
    sha256: string;
    exit_code: number
}>;

async function inspectDocument(document: FilePath): Promise<{
    preview: string;
    bytes: number;
    sha256: string;
    valid: boolean
}> {
    const result = await inspect_document_by_code("python", `
from pathlib import Path
import hashlib
file = Path(document)
if not file.is_file():
    raise ValueError("Document file is missing")
if file.stat().st_size > 32768:
    raise ValueError("This small example accepts documents up to 32 KiB")
data = file.read_bytes()
preview = data.decode("utf-8")
if not preview.strip():
    raise ValueError("Document must not be empty")
bytes = len(data)
sha256 = hashlib.sha256(data).hexdigest()
`, {document});
    return {preview: result.preview, bytes: result.bytes, sha256: result.sha256, valid: result.exit_code === 0};
}

export async function main(brief: FilePath, references: DirPath): Promise<{
    document: FilePath;
    finished: boolean;
    revisions: number;
    bytes: number;
    reason: string
}> {
    const draft = await draft_document_by_ai("document writer", "Read the UTF-8 requirements file at brief and the Markdown files in references. Use the factual details from both. Create draft.md in the working directory as a short Markdown document (under 120 words) that follows those requirements. Actually write the file; returning a path without creating it is not completion. Keep brief and references unchanged. Do not access the network or unrelated files. Return the relative document path.", brief, references);
    const document = draft.document;
    for (let revision = 0; revision <= 2; revision++) {
        const before = await inspectDocument(document);
        if (!before.valid) return {
            document,
            finished: false,
            revisions: revision,
            bytes: 0,
            reason: "Document inspection failed"
        };
        const review = await review_document_by_human("Review the document below. finished: choose Yes to finish with this version, or No to request a revision. feedback: describe your changes when requesting a revision; otherwise press Enter. Closing input leaves this task waiting.", document, before.preview, revision);
        const current = await inspectDocument(document);
        if (!current.valid || current.sha256 !== before.sha256) return {
            document,
            finished: false,
            revisions: revision,
            bytes: 0,
            reason: "Document changed or disappeared during review; no completion or automatic revision was accepted"
        };
        if (review.finished) return {
            document,
            finished: true,
            revisions: revision,
            bytes: current.bytes,
            reason: "Finished reviewed document"
        };
        if (revision === 2) return {
            document,
            finished: false,
            revisions: revision,
            bytes: current.bytes,
            reason: "Revision limit reached; draft retained for inspection"
        };
        const revised = await revise_document_by_ai("document editor", "Read brief, the Markdown files in references, and the existing document file. Apply the human feedback by editing that same document file in place. Keep it under 120 words. Do not modify brief or references, create another document, or access the network or unrelated files. Return the same relative document path after actually writing the changes.", brief, references, document, review.feedback);
        if (revised.document !== document) return {
            document,
            finished: false,
            revisions: revision + 1,
            bytes: 0,
            reason: "AI returned a different document path; inspect its effects before starting again"
        };
    }
    return {document, finished: false, revisions: 2, bytes: 0, reason: "Document review did not finish"};
}

# Work with files and directories

Give the workflow a requirements file and a directory of reference notes. Codex reads both and creates a short
Markdown draft on disk. Code reads the draft and computes its size and hash. You
review its path and full text in the terminal, then finish or give feedback for
Codex to edit the same file. There is at most one initial draft and two revisions.
No Studio, server or database is required.

The executable [workflow.ts](workflow.ts) uses `draft_document_by_ai`,
`inspect_document_by_code`, `review_document_by_human` and
`revise_document_by_ai`. A small internal `inspectDocument` workflow reuses the
same Code check before and after review. These names describe the business work;
there is no special file-editing protocol.

## Typed paths

```ts
type FilePath = string;
type DirPath = string;

declare function draft_document_by_ai(role: string, prompt: string, brief: FilePath, references: DirPath): Promise<{ document: FilePath }>;
```

The host copies the supplied brief and this example's [reference notes](references/club.md)
into the new workspace. The workflow passes `brief.md` and the `references` directory
as distinct typed arguments. Codex must read the directory's Markdown files and use
the venue in its output. Edit the bundled notes before a new run to try different
reference material; the workflow operates on copies.

## Run with Codex

Use Node 22 or 24, npm, Bash, Python 3 and [an installed, signed-in Codex CLI](../../docs/quickstart.md#install-and-sign-in-to-codex). From
the repository root (see [environment setup](../../docs/quickstart.md#check-your-environment)):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
node examples/document-review/run.cjs --input examples/document-review/brief.sample.md --output /tmp/openhilo-document
```

Choose a **new output directory**. Quote paths containing spaces. To try your own
requirements, pass a nonempty UTF-8 Markdown/text file of at most 64 KiB. The host
copies it to `workspace/brief.md`; your original file is never modified. Start
small: the AI is asked to produce fewer than 120 words. This example calls real
Codex with low reasoning effort and a two-minute bound per attempt. No automatic
retry or provider fallback is configured; time bounds are not token/cost caps.

The directory contains:

- `workspace/brief.md`: copied requirements, passed as a `FilePath` input;
- `workspace/references/`: copied reference notes, passed as a `DirPath` input;
- `workspace/draft.md`: the document Codex creates and then edits;
- `artifacts/`: compiled workflows and original TS sources;
- `runs/`: execution records, source snapshots, Human requests and AI results.

AI's working directory is `workspace`, separate from the host's records and
compiled artifacts. The host does not generate the document or save AI prose on
its behalf. A returned path must point to a real file inside that workspace.

At each review, the terminal displays the document path, complete text and revision
number. The declared business fields are:

- `finished`: choose **1 / Yes** to finish with the displayed version, or **2 / No**
  to request another revision.
- `feedback`: describe the desired edits when requesting a revision. When finished
  is Yes, press Enter to leave this field empty.

For the sample, try: “Change the meeting to Thursday at 19:00 and ask visitors to
bring a notebook.” A revision is a new AI task that reads the requirements, reference directory and existing document
and receives your feedback. It is not a recovered model conversation. The final
review after two revisions can finish, or end as unfinished with the draft retained.
Code checks that the file exists, is nonempty UTF-8 and no larger than 32 KiB.
The before/after-review hashes must agree before accepting completion or asking
AI to revise; edits made outside the workflow while a person is reviewing fail
visibly. This is not semantic validation of the AI's writing.

## Pause and resume in another process

To create the first draft and deliberately exit at the Human checkpoint:

```sh
node examples/document-review/run.cjs --input examples/document-review/brief.sample.md --output /tmp/openhilo-document-paused --defer-human
```

The process exits 2 and prints `Records: <run directory>`. The draft **already
exists on disk**. Open a new terminal, select Node 22/24 and return to the
repository root. Replace the quoted placeholder below with the exact Records
path, without angle brackets; do not pass the top-level output directory:

```sh
node examples/document-review/resume.cjs --run-dir '<printed Records path>'
```

Choose No and enter feedback to have Codex edit the same document. Choose Yes at
the next review to finish. Ctrl+C or EOF at a Human prompt leaves that request
waiting, including on a later round. Reopen it with the same resume command.
Completed AI tasks are not repeated. The host resumes the saved workflow source,
not the current example file, and verifies the example/provider receipt.

Keep the **entire output directory at its original location**. `FilePath` is a
path contract, not a copy of file contents. Recovery does not recreate missing
files or roll back disk changes. Do not edit or move the draft, requirements, reference notes,
records or source snapshot while the run is paused. If a run fails after an AI
attempt, inspect the actual files; unconfirmed effects are not automatically
replayed. Ctrl+C during AI requests cancellation and waits for cleanup; it is not
an undo operation. Local Code runs with your account's privileges.

## File contracts and scope

`type FilePath = string` and `type DirPath = string` mark standalone typed parameters/outputs as `file` and `dir`.
Within the TS workflow they are path strings, so one node's output can be the next
node's input. After an AI result, Runtime checks existence, file type and workspace
containment (including symlink resolution), then records file metadata. Code
actually reads the path it receives. Merely returning a filename is insufficient.

Codex is configured with `workspace-write` for this example; the existing text
report example remains `read-only`. A type annotation does not grant permissions.
SDK providers need host-supplied file tools and are not configured by this example.
Local Code runs with host permissions and is not sandboxed by the Codex setting.

Exit 0 means the reviewed document passed final checks; 1 indicates a host/input
error; 2 means the run did not finish successfully, including Human suspension,
revision limit, rejected file changes or execution failure. Keep the printed
Records path for inspection. `ai-attempts.jsonl` records confirmed AI results and
reported usage; absent usage is unknown, not zero.

Automated tests use an explicitly injected filesystem fixture adapter (not an AI)
to cover errors and repeatable recovery. The CLI uses real Codex only. See the
[validation guide](../../docs/validation.md#examples-and-real-providers) for provider coverage.

# AI drafts, Human reviews, Code saves

Executor names describe the business work: `draft_report_by_ai` → `review_report_by_human` → `save_report_by_code`.
See [the naming convention](../../docs/executor-naming.md); the suffix only identifies the executor.

This source example compiles [workflow.ts](workflow.ts) and [format.ts](format.ts).
It runs a small AI writing task, lets you approve or request revisions, formats
an approved draft through a function in another TS file, then saves Markdown.
The `saveReport` helper calls the imported formatter and checks the Code exit status.

## Run

Use Node 22/24, npm, Bash and `python3`; see
[environment setup](../../docs/quickstart.md#check-your-environment).
Run these commands from the repository root, not this example folder:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
node examples/review-report/run.cjs --provider offline --input examples/review-report/input.sample.json --output /tmp/openhilo-review-offline
```

`offline` is explicitly **scripted** and not model-generated. Choose it to learn
the complete flow at no model cost. The input has `topic` and `notes` strings;
copy [input.sample.json](input.sample.json) and edit them for another task. The
output directory must be new. Quote paths containing spaces.

To use a real model, complete [Codex installation and sign-in](../../docs/quickstart.md#install-and-sign-in-to-codex), and
replace `--provider offline` with `--provider codex`. The example reports the CLI
version without restricting it, uses low reasoning effort and a two-minute bound per attempt, and asks
for only one or two sentences. It does not automatically choose a provider,
change your account, or fall back to another service. Each review round is a new
AI task using explicit previous text and feedback, not a recovered AI session.

At each Human node:

- Is the report ready to save? For `approved`, choose `1` (Yes) to let the workflow save it, or `2` (No) if it needs changes.
- `feedback`: type your response, or press Enter for an empty string. This field is always collected, including when
  approved is true.
- Ctrl+C or EOF: pause with the Human request still waiting.

There are at most three model attempts. Three unsuccessful reviews end without
saving. Invalid typed values are reprompted. The terminal shows the draft,
current step, AI phase and elapsed time. A slow warning means the active-time threshold was exceeded. Stalled means no
progress or a tool exceeding the stall threshold; neither proves the process has crashed.
Stopping remains visible until execution cleanup actually settles.

AI may also ask a *temporary clarification*. Options are numbered when provided.
This is answered on the active AI execution and is not a persisted Human task.
Without an interactive terminal such a question cancels the attempt with an
explicit message; it cannot steal scripted answers intended for a Human node.

## Suspend and resume in another process

```sh
node examples/review-report/run.cjs --provider offline --input examples/review-report/input.sample.json --output /tmp/openhilo-review-deferred --defer-human
```

The command generates a draft, saves a pending Human request, prints `Records:`
and exits with status 2. In a new terminal, return to the repository root and
select Node 22/24. Replace the quoted placeholder below with that exact Records
directory, without angle brackets; do not use the top-level output directory:

```sh
node examples/review-report/resume.cjs --run-dir "<printed Records path>" --provider offline
```

Resume reads the original snapshot and saved provider receipt. It does not
recompile the current TS or repeat the completed draft step. You can still ask
for a revision and approve a later round. If you used Codex, resume with
`--provider codex`; a mismatched provider is rejected before changing the run.
An expired/missing snapshot or unsafe interrupted effect is not guessed/replayed.
This is safe Human-point recovery, not arbitrary crash recovery.

EOF or Ctrl+C at the Human prompt also leaves its request suspended. Run resume
with the printed path to continue. Ctrl+C during AI asks the executor to stop and
waits for its authoritative result; it does not promise rollback of effects.
Ctrl+C also cancels local Code through the host's AbortSignal and waits for
process-group cleanup. This example does not configure a Code deadline; hosts
can opt into one with `createCodeExecutor` options. Cancellation does not undo
earlier writes, and local Code is not an isolation sandbox.

The source files, compiled graph and maps are in `artifacts/`; all snapshots and
Human receipts are under the printed run directory. `ai-attempts.jsonl` records
provider, task inputs, confirmed results and reported usage. Missing usage is
`null`, never zero. These are your local task records, not files to commit publicly.
The final `report.md` only appears on the approved/save path. A nonzero Code exit
is checked before claiming success. Inspect any partial output on a save failure.

Exit 0 means a report was saved; 1 is an input/configuration error; 2 means the run
did not save (including deferred Human input). A completed engine run with
`approved=false` is not presented as a successfully saved report.

Codex uses its own read-only sandbox for this text example; Code still writes the
approved report using your local account's permissions. This is not a sandbox for
untrusted workflows. No server or database is required. Run this example from the source checkout.

Console presentation: `[log]` progress, timing and usage are dimmed in interactive terminals. Task content and questions
use the terminal default foreground; input prompts may be bold. Errors remain prominent. Piped output, `NO_COLOR`, and
`TERM=dumb` use plain text. Styling never enters saved workflow events.

# Local report — useful without an AI account

Executor names describe the business work: `summarize_items_by_code` → `review_report_by_human` → `save_report_by_code`.
See [the naming convention](../../docs/executor-naming.md); the suffix only identifies the executor.

Compile a TypeScript workflow, summarize your own small JSON dataset with Python,
review the result in your terminal, and choose whether to save `report.md`.
**This example does not call AI**, start a server, or read platform data.

Use Node 22 or 24, npm, Bash and `python3`. Commands use a macOS/Linux-style
shell; native Windows is not verified. See [environment setup](../../docs/quickstart.md#check-your-environment)
for version warnings and missing executables. From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
node examples/local-report/run.cjs --input examples/local-report/input.sample.json --output /tmp/openhilo-my-first-report
```

Use a **new output directory** for every run. Paths with spaces are supported when
quoted. For your own data, copy [input.sample.json](input.sample.json), edit it,
and pass its path through `--input`. It must be a nonempty array of entries with a
nonblank `title` and finite numeric `value` (negative zero is unsupported).
Values may be negative; the total must remain finite. This is an illustrative
numeric report, not financial accounting software.

The saved file is `<output directory>/report.md`. The sample totals **10.5**. The terminal shows a readable report
preview and its
input values. At the human prompt:

- For `approved`, enter `1` (Yes/true); the workflow saves the report.
- For `approved`, enter `2` (No/false); the workflow completes with `saved: false` and the command exits 2.
- Invalid or blank menu choices are reprompted.

Ctrl+C or EOF **at the human prompt** leaves a suspended request and exits 2;
no result or saved report is invented. Records remain for inspection. This
entry command starts new runs; use the separate review-report example for the
new-process resume walkthrough. It does not promise cancellation of an arbitrary
running local-code process.

For an explicitly scripted, noninteractive approval, stdin is supported:

```sh
printf '1\n' | node examples/local-report/run.cjs --input examples/local-report/input.sample.json --output /tmp/openhilo-scripted-report
```

Only use that when you intend to approve without reading the preview yourself.
No input on a pipe is an EOF, not an automatic approval. Exit 0 means the report
was saved, 1 is a configuration/input error, and 2 is a run that did not save it.

## Inspect and modify the workflow

[workflow.ts](workflow.ts) is the actual compiled source. It calls Code, Human,
and Code like async functions, checks the process exit codes, and branches on
your approval. Local code takes an explicit object of named inputs after its
literal language and script arguments, e.g. `{ items }`; arguments are passed as
JSON globals to Python, not interpolated into a shell command. Unsupported Code
input shapes fail compilation instead of silently dropping values.

The output directory contains:

- `report.md` after successful approval and saving;
- `artifacts/`: ITT declarations, implementations, source maps, and original TS;
- `runs/`: run receipt, saved source snapshot, human request/receipt and event log.

Use the exact `Records:` path printed at exit; run paths are nested and should
not be guessed. Changing the sample data or TS only affects a new run. Failed
runs are retained rather than overwritten or cleaned up automatically.

Local Code inherits your account's permissions. Run trusted workflow source.
This source example is distributed with the repository; it is not claimed to be
included in any single package's npm archive.

Console presentation: `[log]` progress, timing and usage are dimmed in interactive terminals. Task content and questions
use the terminal default foreground; input prompts may be bold. Errors remain prominent. Piped output, `NO_COLOR`, and
`TERM=dumb` use plain text. Styling never enters saved workflow events.

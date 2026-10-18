# Repair a small script — Code tests, AI edits, Code retests

This standalone example copies a deliberately broken Python script into a new
workspace. Code runs six fixed tests, passes the actual failure report to Codex,
and runs the same tests again after Codex edits the file. The workflow allows
**at most two AI repairs and three test runs**. Passing on the first run uses no
AI. No Studio, server or database is required.

The [workflow](workflow.ts) calls `run_script_tests_by_code` and
`repair_script_by_ai`. A reusable `testScript` function wraps the Code step;
a normal `for` loop handles test → repair → retest. File paths and structured
results travel through the existing function contracts.

## Run

Use Node 22 or 24, npm, Bash, Python 3 and an installed, signed-in Codex CLI.
Complete [Codex installation and sign-in](../../docs/quickstart.md#install-and-sign-in-to-codex) first.
From the repository root (see [environment setup](../../docs/quickstart.md#check-your-environment)):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
codex --version
node examples/script-repair/run.cjs --output /tmp/openhilo-script-repair
```

Choose a **new output directory**; quote paths with spaces. The console displays
actual test failures, AI progress, the subsequent test results, the repaired
script path and the Records path. Progress logs are dim in interactive terminals;
test reports and the final result remain normal foreground text.

The sample's `average(values)` incorrectly uses integer division and does not
handle an empty list. The [fixed tests](sample/test_calculator.py) check integer,
fractional, negative and singleton inputs, preservation of the input list, and
`ValueError` for an empty list. Codex must modify `calculator.py` in place. It is
asked not to run tests itself: the next Code step supplies the verification.
Success requires all six tests to finish and pass, not a model's success claim.

To try a different implementation of **this same function and contract**:

```sh
node examples/script-repair/run.cjs --input /path/to/your/calculator.py --output /tmp/openhilo-another-repair
```

Input must be nonempty UTF-8 Python source, at most 64 KiB, defining
`average(values)`. This is a small executable example, not a general project
repair service. The original input file is never edited; work happens on a copy.
Run only code you trust: the local Code executor uses your account's privileges.

## Inspect the result

The output directory contains:

- `workspace/calculator.py`: the copied script, subsequently edited by Codex;
- `workspace/test_calculator.py`: a copy of the fixed regression suite;
- `artifacts/`: compiled workflow and original TypeScript source;
- `runs/`: workflow records, source snapshots and `ai-attempts.jsonl`.

You can independently rerun the fixed suite without an AI call:

```sh
python3 -B /tmp/openhilo-script-repair/workspace/test_calculator.py
```

`FilePath` is a string alias compiled to the existing `file` contract. AI receives
relative paths plus the actual Code failure report. Its returned path must exist,
remain inside the workspace and equal the input source path. It does not send
Python source back for the host to pretend to save; Codex actually edits the file.
The AI uses the existing `workspace-write` setting, with low reasoning effort and
a two-minute deadline per attempt. No automatic retry or provider fallback is
configured. These limits bound attempts and time, not token cost.

## Failure handling and limits

A failed assertion is normal **workflow data**. The Code wrapper itself completes
with `exit_code: 0`, while `testExitCode` records the test process's exit status
and `passed` is false. This lets the workflow give the report to AI instead of
aborting on the first failed assertion. A test process exceeding five seconds
is stopped and produces timeout feedback (`testExitCode: -1`). The captured
report sent to AI retains the last 4,096 characters, plus any missing-completion
explanation. Capturing process output is not a memory or OS resource sandbox.

The host hashes the fixed tests before execution. Each Code step verifies that
hash before and after running them. A changed or missing test file fails visibly.
A zero exit code without the fixed suite's six-test completion record is also a
failure. These are checks against accidental false success, not protection from
malicious Python code forging results or changing files between checks. Do not
edit files concurrently. The Codex sandbox does not sandbox the Code executor.

If the second repair still fails, the workflow stops and retains the current
script and reports. AI errors, missing output files, changed test files or a
returned different path also stop visibly; no unconfirmed file effect is replayed.
Ctrl+C during AI requests cancellation and cleanup; it does not undo file edits.
This example has no Human checkpoint or resume CLI. Use
[document review](../document-review/README.md) to try Human pause and recovery.

Exit 0 means all six tests passed; 1 means a host/input error; 2 means the workflow
did not achieve passing tests, including an exhausted repair limit or execution
failure. Inspect the retained files before deciding to start another run.

Automated regression uses an explicitly injected filesystem fixture adapter,
not a model. The CLI always selects real Codex. See the
[validation guide](../../docs/validation.md#examples-and-real-providers) for provider coverage.

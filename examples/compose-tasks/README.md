# Compose Human, AI and Code tasks

Provide a focus → summarize supplied text → save `summary.md`.

## Workflow

```ts
export async function main(text: string): Promise<{ saved: boolean }> {
    const requirements = await provide_requirements_by_human("What should the summary focus on?");
    const summary = await summarize_text_by_ai(
        "analyst", "Summarize text in 1–2 sentences using focus. Return report; do not use tools.",
        text, requirements.focus
    );
    const saved = await save_summary_by_code("python", `
with open("summary.md", "x", encoding="utf-8") as output:
    output.write(report)
`, { report: summary.report });
    return { saved: saved.exit_code === 0 };
}
```

[Complete source and declarations](workflow.ts). The host compiles this workflow
and provides the adapters; it is not executed as an ordinary Node script.

## Run

Use Node 22/24, npm, Bash and Python 3. From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
node examples/compose-tasks/run.cjs --provider offline --input examples/compose-tasks/input.sample.json --output /tmp/openhilo-summary
```

When asked what to focus on, enter `Release dates` and press Enter. Open
`/tmp/openhilo-summary/summary.md`. The offline adapter echoes the source and your
requirements; it is a scripted demonstration, not a model summary.

To run real AI, [install and sign in to Codex](../../docs/quickstart.md#install-and-sign-in-to-codex),
then use `--provider codex` and a new output directory. This makes one short text
request, with low reasoning effort and a two-minute attempt deadline. Codex uses
its read-only sandbox; Code writes the summary with your account's permissions.

Copy [input.sample.json](input.sample.json) and change `text` to supply your own
content. Always choose a new output directory; quote paths containing spaces.

## Results and limits

Exit `0` means Code saved the summary; `1` means invalid setup/input; `2` means the
workflow did not save, including Human input left pending. Closing input is not
an answer and starts no AI work. This minimal host has no resume command: continue
with [review-report](../review-report/README.md#suspend-and-resume-in-another-process)
for the restartable host and a revision loop.

Source snapshots, execution records and AI results stay under the output directory.
No server or database is required. See [environment setup](../../docs/quickstart.md#check-your-environment).

# Choose AI configurations by task

Run from the repository root after `npm ci --ignore-scripts --no-audit --no-fund` and `npm run build:packages`.
Use Node 22 or 24 and an installed, authenticated [Codex CLI](https://github.com/openai/codex).

The workflow first uses the default AI, then asks whether to continue with a coding
suggestion. It pauses for Human input, exits, and resumes in a new process. There
are at most two coding calls. No files are modified by the AI in this example.

```sh
node examples/model-routing/run.cjs --output ./routing-demo --topic 'A reading list'
# Copy runDir from the result; this is a NEW process:
node examples/model-routing/resume.cjs --run-dir "<complete printed runDir>" --continue true
# After the next pause, either continue once more or finish:
node examples/model-routing/resume.cjs --run-dir "<complete printed runDir>" --continue false
```

Choose a new output directory for each run. `--continue` is the workflow's business
answer, not an executor approval. The example deliberately exposes the two-process
commands; applications can render this boolean as a choice instead.

Replace the whole quoted placeholder, including its angle brackets, with the
printed `runDir`. It includes `runs/<intent>/<workdir-key>/<run-id>`; substituting
only a run ID into `runs/RUN_ID` does not identify the saved run.

## Configuration

Edit [ai.config.json](ai.config.json), or pass `--config /absolute/path/ai.json` to
**both** commands. Each type/level cell contains one direct Codex or SDK configuration.
No executor registration, candidate selection, or revision value is needed.

The sample uses the installed CLI's default model with low effort for default/medium
and medium effort for coding/pro, so it can run without a hard-coded model name.
Set `model` to an identifier available to your account to select a specific model.
Type and level are routing labels, not a promise about model quality or permissions.

```ts
/** @ai.type coding
 * @ai.level pro
 */
declare function explain_implementation_by_ai(
  role: string, prompt: string, text: string
): Promise<{text: string}>;
```

No type → `default`. No level → that type's `defaultLevel`. Explicitly missing
routes fail; they never silently switch to a different model. Changing a configured
route blocks resume before an answer is consumed; restore the original configuration.
Changes outside that file (CLI defaults, provider aliases, installed tools) cannot be
frozen by this check. Pin `model` explicitly when that distinction matters.

For SDK cells, see [AI routing](../../docs/ai-routing.md). This example's
[config.cjs](config.cjs) is a small host composition over public package APIs.

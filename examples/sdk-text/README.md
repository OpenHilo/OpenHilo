# SDK text summary (experimental)

Use the official OpenAI or Anthropic SDK through `SdkTaskExecutor` to summarize a
text file. **Both providers are tested with local protocol fixtures; live API behavior
has not yet been verified.** Running these commands calls a paid API.

Use Node 22 or 24 and npm. This example does not require Python, Bash or Codex
CLI. From the repository root, install and build first:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
```

Choose **one** provider and set both variables in the same shell that runs Node:

| Provider  | API key variable    | Model variable    |
|-----------|---------------------|-------------------|
| OpenAI    | `OPENAI_API_KEY`    | `OPENAI_MODEL`    |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` |

Use a model ID available to your API account that supports tool calls. No default
ID is selected. Set keys through your normal credential mechanism; a `.env` file
is **not automatically loaded** by these scripts. For example, after loading your
key into the shell, set the matching model with `export OPENAI_MODEL='your-model-id'`
or `export ANTHROPIC_MODEL='your-model-id'`, replacing the placeholder. Codex CLI
login does not configure these SDK variables or pay for API usage.

Run the matching command:

```sh
# Set OPENAI_API_KEY and OPENAI_MODEL using your normal credential mechanism.
node examples/sdk-text/run.cjs --provider openai --input examples/sdk-text/input.txt

# Or set ANTHROPIC_API_KEY and ANTHROPIC_MODEL, then:
node examples/sdk-text/run.cjs --provider anthropic --input examples/sdk-text/input.txt
```

No default paid model, automatic provider fallback, or automatic HTTP retry is
configured. Keys must not be committed. Only the selected provider's variables
are read; explicit official API endpoints are used. The fixture tests use injected
local fetch transports and never use your credentials.

The example host reads the file you name and passes its text into
`SdkTaskExecutor.start(request, host)`. **It supplies neither `workspace` nor
business `tools`**, so the model is not given general file access. Internal
`finish_task` and `ask_user` belong to the adapter protocol; you do not have to
implement tools to do plain text work. A model must support that protocol.

A summary is accepted only after `finish_task` returns the declared text field.
Arbitrary assistant prose is not assumed to be a completed result. Unexpected
questions cancel with a clear message, because this example has no interactive
question handler. The session is released after the authoritative result settles.

Status/progress goes to stderr; stdout contains JSON `outputs` and `usage`.
On success (exit 0), `outputs.summary` contains the generated text. There is no
`--output` directory, Human prompt or resume command in these direct SDK examples.
Use a nonempty UTF-8 text file for `--input`; change its path to summarize your own
text. For example, the output shape is:

```json
{"outputs":{"summary":"The generated summary appears here."},"usage":null}
```

Unreported usage is `null`, not zero. Errors return exit 1 with a category such as
`authentication_failed` or `rate_limited`, without echoing SDK headers or keys.
Ctrl+C requests cancellation and waits for the task lifecycle to settle.

The example bounds attempts to two minutes, four model turns/four tool calls and
512 output tokens per model turn. These are operational limits, not a hard dollar
budget. A model can still return an inaccurate summary; inspect business results.

This direct SDK path differs from a Runtime AI node: Runtime currently injects a
workspace and requires workspace capability, so its file-access policy depends on
the configured executor. This example runs without Runtime,
Codex, a server or a database.

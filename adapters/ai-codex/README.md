# @openhilo/ai-codex

Independent implementation of `AiTaskExecutor` backed by the locally installed Codex CLI. It uses
`codex app-server --listen stdio://`, not an OpenAI API client. Runtime and Compiler remain provider-independent.

## Use

Install Codex CLI and authenticate using its own login flow. No CLI version allowlist is enforced: the adapter attempts
the app-server protocol and validates actual replies, tool calls and outputs. An incompatible protocol fails explicitly;
check the CLI configuration, update Codex or this adapter, and inspect any effects before retrying. The live-tested
version is 0.160.0; this is evidence, not a version requirement.

```js
const { CodexTaskExecutor } = require('@openhilo/ai-codex');
const executor = new CodexTaskExecutor({
  cliPath: 'codex', // executable name on PATH or explicit path; never a shell command
  effort: 'low',
  sandbox: 'workspace-write',
  timeoutMs: 43200000,
});
// Supply executor as aiExecutor to createDispatcher from @openhilo/runtime/dispatcher.
```

An embedding application can validate this serializable selection with
`parseAiExecutionConfig` from `@openhilo/studio-contracts/ai-config`:

```json
{
  "adapter": "codex",
  "cli_path": "codex",
  "effort": "low",
  "sandbox": "workspace-write",
  "timeout_ms": 43200000
}
```

This JSON is an application configuration shape, not the constructor options above.
The host maps `cli_path` → `cliPath`, `timeout_ms` → `timeoutMs` and
`codex_home` → `codexHome`; `model`, `effort` and `sandbox` keep their names.
The parser does not instantiate an executor or read a deployment file. See the
[configuration boundary](../../packages/studio-contracts/README.md#ai-configuration-does-not-install-an-executor).

Constructor defaults: `cliPath` is `codex`, `sandbox` is `workspace-write`, `id` is `openhilo.codex`, and an omitted
`effort` uses Codex's own default. Invalid options throw at construction.
Optional `model` selects a CLI model; omitted means Codex's configured default. Optional `codex_home` selects a separate
CLI home, including its authentication/configuration. Credentials remain owned by Codex and are never embedded in
session references. Constructor/configuration reads do not launch Codex. A React 19 application can explicitly import
`codexStudioSettings` from `@openhilo/ai-codex/studio`. The optional entry is TSX for a bundler; the main entry does not
require React. Source `examples/review-report` composes this adapter with Runtime and terminal Human decisions, without
a server.

## Contract behavior

- Declared capabilities: structured output, workspace, tools, questions, usage and continuation. No live-attempt
  reconnect or hard dollar budget. A task profile is rejected: select the model in executor configuration.
- The child runs in the host's existing local workspace. Host tools become namespaced-by-adapter function names; calls
  map back to the exact host definitions and emit contract tool events. Codex's built-in tools remain controlled by
  Codex's sandbox, not by `ToolHost`.
- A fixed schema requests a `resultJson` string. The adapter parses that JSON object and validates every declared output
  type, including arbitrary nested `json` values. An exit code, prose message or malformed result cannot establish
  completion.
- `openhilo_ask_user` works through the normal question/answer lifecycle. Native non-secret user-input requests are
  supported too. Command/file approvals are declined, permission expansion is not granted, and unknown server requests
  fail explicitly. No bypass-sandbox flags are used.
- Cancellation interrupts the active turn and terminates the owned process group; deadlines also cover initialization.
  Host tool implementations must honor their AbortSignal. Frames are bounded to 4 MiB; stderr is drained but never
  retained in task history. JSON-RPC responses may use numeric or string ids; an uncorrelated error response
  (`id: null`) fails the attempt rather than waiting for a request timeout.
- Usage is the reported cumulative token delta for this attempt, not just the final inference. Unknown usage/cost stays
  absent. Timeout is a duration bound, not a token or cost cap. Even a tiny task can include a large CLI system/context
  prompt.
- Continuation records thread identity, workspace, configuration/tool fingerprints and token baseline. Changes fail
  closed. Finished processes are closed; later continuations use `thread/resume`. The CLI retains its normal session
  files. Do not run concurrent continuations of the same saved thread from different executor instances.
- No automatic task retries or provider fallback. Interrupted generation snapshots require inspection rather than
  replaying an uncertain attempt.

## Validation

`npm run test:offline` (from the repository root) uses executable local protocol fixtures and forbids the real
`codex` command; `npm test --workspace @openhilo/ai-codex` runs only this package's tests. Adapter tests cover
output errors, tool/question forwarding, cancellation, initialization timeout, session binding, cross-thread requests
and denied approvals. Live tests must be deliberately separate, short and user-authorized.

Protocol
references: [app-server](https://developers.openai.com/codex/app-server), [Codex CLI](https://github.com/openai/codex).
No upstream implementation or generated source is bundled in this package.

Unsafe host tool failures stop the turn immediately rather than letting the model
try a second invocation. Protocol/model failure closes the app-server before waiting
for host tools to drain. The continuation remains reserved until those effects settle;
health events expose startup, model, tool, cleanup and stopping phases. A hung host
tool can therefore keep `result` pending with stalled cleanup health even after the
CLI process has exited. No automatic replay or implied rollback is performed.

The adapter checks protocol compatibility rather than restricting CLI version numbers. Small live acceptance covered direct approval
and a multi-process revision/resume journey; ordinary package tests use protocol fixtures. The CLI and login must be
installed/configured separately.

`timeoutMs` / `timeout_ms` defaults to 43,200,000 ms (12 hours) of active execution.
Waiting for answers pauses this budget. Manual cancellation still interrupts the
owned process; timeout or cancellation does not automatically replay work. An
explicit host deadline can further restrict the initial budget.

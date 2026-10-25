# @openhilo/runtime

Independent Node.js execution of ITT v2 workflows: CFG control flow, nested calls, variable scopes, node inputs/outputs,
JSONL events, large-value references, checkpoints and controlled suspension recovery. Its only package dependencies are
`@openhilo/itt-contracts`, `@openhilo/runtime-contracts`, `@openhilo/ai-contracts` and `@openhilo/human-contracts`.

There is no default AI backend, domain policy, database, home directory, SDK, Claude process, quota discovery or MCP
connection. Supply execution resources explicitly. MCP/application question bridges belong to the embedding host.

## Run the offline example

```sh
node node_modules/@openhilo/runtime/examples/suspend-resume.cjs
```

From this monorepo, first build workspace dependencies, then run:

```sh
npm run build:packages
npm test --workspace @openhilo/runtime
node packages/runtime/examples/suspend-resume.cjs
```

The example uses a fake `AiTaskExecutor` with the public task contract. It creates a temporary run and workflow
snapshot, executes one AI node, suspends at a human node, reads saved state, supplies a typed answer, and resumes to
completion. It checks that the AI node is not replayed and removes only its temporary directory. No credentials or model
requests are involved.

## Public composition

- `ExecutionEngine` accepts explicit run/workspace/snapshot paths, workflow identity, input values, evaluator,
  run-status writer and an optional `ExecutorFn`. `intent` calls and `human` suspension are engine semantics. Other leaf
  calls are sent to the injected executor; a missing executor fails visibly.
- `dispatchAiTask` translates one AI call node into `AiTaskExecutor` requests, validates outputs, verifies file outputs
  remain inside the workspace and releases completed sessions. `AiDispatchOptions` supplies event/question attachment
  and tool/cancellation hosts. Pass `aiExecutor` for normal injected providers; required legacy CLI skills are then
  rejected until an explicit resource adapter exists. This core does not include a legacy Claude skill host.
- `RuntimeExtensionPolicy` derives and validates namespaced, versioned frame context. With no policies the context is
  empty. Restore requires matching policies, including their versions; only explicit legacy migration may fill absent
  old extension state.
- `RunManager` manages existing run.json/directory/PID-lock conventions. `Logger` preserves JSONL and `io_records`
  formats. `Rehydrator` only restores a final, complete `suspended_state`; a truncated/invalid final record does not
  fall back to an older suspension.
- `ScopeManager`, `EvalEngine`, `AbortError`, `FailableError`, runtime events and state types are public. Errors are
  re-exported from one contract implementation so `instanceof` remains consistent across these public imports.

Snapshots use explicit flat files named `<intentName>.itt.impl.json` (preferred) or `<intentName>.itt.json`. Virtual
compiler artifact IDs, such as `math.numbers.sum`, may be used as the intent name and file stem. The application
prepares and validates the complete snapshot before execution. Source discovery and installation belong to the embedding
application.

A human node durably suspends by default. Inject `humanExecutor` to display it using an adapter; Runtime has no terminal
or Studio implementation. Source examples supply `TerminalHumanExecutor`; applications can implement their own adapter.
The run service is the recommended recovery API; direct engine consumers own evaluator and lock cleanup. AI model
questions are distinct: attach `onAiExecution` / `aiHost` to the task bridge to provide answers through the execution
handle.

A human call whose callee matches its currently executing workflow stays a human operation (for example, `review_report`
calling `review_report_by_human`); it must not recursively delegate to its own implementation. Existing delegation to a
distinct implementation workflow remains supported.

## Limits

Recovery is based on controlled Human checkpoints, not arbitrary crash recovery or exactly-once execution. PID locks
coordinate processes on the same host; they are not distributed leases. A workflow retry is an explicit caller decision and must consider
executor side effects. Historical malformed log lines remain tolerated, but a malformed terminal record prevents
recovery.

The evaluator uses Node `vm`, a timeout and supplied variables. It is **not a security sandbox for untrusted code**.
Execute trusted workflows in an appropriately restricted process. State storage remains the filesystem implementation.
Workflow generation, review and publication belong to the embedding application. Runtime provides the
controlled Human checkpoint recovery described below; no external platform service is required. It validates
snapshots and retained values, but does not provide a general storage backend or repair arbitrary run data.
Filesystem paths and workflow identifiers supplied by an application must be trusted and validated by that application.

## File-backed run service

`@openhilo/runtime/run-service` exports `startRun`, `resumeRun`, `validateFile` and `parseKvPairs`. It composes run
directories, snapshot validation, input coercion, engine/evaluator lifecycle, persisted extension state and human
suspension. It does not choose an application or AI provider.

Supply `populateSnapshot(context)` and `createResources(context)`. The snapshot callback receives the new run's
`.snapshot` directory. The resource factory receives the run id, run/workspace/snapshot paths and actual entry
identifier, and returns `{ executor, humanExecutor?, close? }`. A composition-level `humanExecutor` overrides the
resource-level adapter. Optional runtime policies and checkpoint settings are passed explicitly. The service closes
resources on completion, suspension and execution failure. If a factory throws before returning resources, the factory
remains responsible for resources it already allocated.

`receipt` stores JSON composition metadata alongside the run record; it cannot overwrite runtime-owned identity, path or
status keys. Applications use this receipt to restore the same provider and policy choices, then call `resumeRun` with
their rebound factory. The service itself never turns stored metadata into credentials or a default executor.
The source [review example](../../examples/review-report/README.md) demonstrates storing and checking a provider receipt.

A failed snapshot/graph validation aborts before the resource factory runs. Unexpected resource or execution failures
mark the run failed and propagate the error without replay. Human recovery uses the persisted call stack and actual
entry identifier, preserving prior effects and metadata. The service releases its PID lock after all resource cleanup
settles, allowing same-process recovery. An active owner prevents resume; callers must not delete its lock to bypass
this check. With no `inputEncoding`, string input coercion retains historical CLI behavior. Explicit
`inputEncoding: 'typed-text-v1'` validates and decodes every input against the frozen snapshot before resources are
created. The encoding is saved as a runtime-owned run-record field; the host records the original input strings for
retries. Resume uses saved scope values and does not decode inputs again. See
[run input encoding](../../docs/embedding.md#run-input-encoding).

## Leaf executor composition

`@openhilo/runtime/dispatcher` exports `createDispatcher`. Supply `aiExecutor`, `codeExecutor` and `sysExecutor`
explicitly for the leaf types used by a workflow. Missing ports fail visibly; the built-in `getWorkdir` system call
returns the supplied workspace. Code and system ports receive the runtime extension context unchanged. Human suspension
and nested intent calls remain engine semantics.

The optional `@openhilo/code-local` adapter supplies Bash/Python execution. Runtime itself has no dependency on it or an
AI backend. The embedding application composes its own providers and system handlers; no application dispatcher
or default Claude Code implementation is included.

`node_pending` log records include optional `frame_id` and `intent_name` fields. These identify the exact snapshot
and invocation frame for application history views. Event consumers can ignore them when not needed.

### Human answer preflight

For a suspended human node, `resumeRun` validates the full answer against the saved current frame's snapshot before
acquiring a new PID lock, creating resources, writing events or changing run status. Invalid submissions leave the
suspension available for correction. Direct engine execution also parses all supplied fields before writing any of them
to scope; the terminal adapter preserves text whitespace and asks again after invalid field input.

Optional `humanNodeRunId` binds an answer to the observed suspended operation. A stale id is rejected before resumption,
including when a loop reaches another operation with the same node id. Existing CLI/programmatic callers may omit it and
intentionally target the current suspension. This compatibility path does not detect a stale caller's intent and is not
exactly-once delivery.

Resume preflight and engine loading use the same run-local snapshot reader. It preserves `.itt.impl.json` and legacy
`.itt.json` lookup while rejecting paths or symlinks that escape `.snapshot`. Human numeric prefixes such as `12abc`,
non-finite values, malformed JSON, missing fields and unknown fields are rejected before resumption. Initial workflow CLI input coercion remains separate.

Run-service hosts can receive live engine events with `onEvent`. The runtime has no IPC or HTTP dependency; the
embedding worker forwards events through its own transport. `startRun` awaits an asynchronous `onRunCreated`
acknowledgment before snapshots and executor resources are created. If that callback rejects, the run is marked aborted
and no workflow effects begin.

## Workflow value persistence

Workflow variables, executor input/output maps, retained loop arrays and value-bearing logs must contain JSON data:
null, booleans, strings, finite numbers other than negative zero, dense arrays and plain objects with enumerable own
string-keyed data properties. Plain objects/arrays produced in Node VM contexts and file-reference records are
supported. Shared acyclic references are preserved inside the workflow, including internal calls and live foreach
targets. Checkpoints encode all frames/scopes together as a versioned JSON graph; cycles remain rejected.

Undefined (including nested properties), non-finite numbers, negative zero, sparse arrays, extra array properties,
bigint, functions, symbols, promises, custom instances/prototypes (including null prototypes), accessors, proxies,
frozen/sealed/nonextensible objects and nonordinary property descriptors are rejected with AbortError instead of
becoming null, disappearing, or being rewritten by toJSON. Values are inspected without invoking getters or toJSON. This
validates retained data; it does not make the trusted-code VM a security sandbox or undo effects already performed by an
expression or executor.

EvalEngine can return undefined as an intermediate JavaScript result, so optional chaining combined with `?? null` and
truthiness conditions remains usable. Writing that undefined result to a workflow variable or passing it to an executor
is an error. Conditions record their resulting boolean. Choose an explicit serializable fallback such as `?? null` when the result may be undefined.

Validation happens before scope writes and executor input effects, and on executor output and retained state before node
success. Invalid executor outputs abort without automatic retry. Scope writes retain native references. Scope snapshots
copy the graph while preserving aliases; the engine shares one copier across all frames. External executor
inputs/outputs and onEvent payloads are detached ownership boundaries. `resumeRun` validates saved scope values before
acquiring its lock, changing the run record or constructing executor resources; it cannot reconstruct values already
lost by older serialization. Legacy tree snapshots remain readable as recorded, without guessing lost aliases. New
checkpoint and suspended_state records store a `StateGraph` in `call_stack`; `LogEvent` observers still receive decoded
`CheckpointFrame[]`. JSONL consumers must call `decodeCheckpointStack(event.call_stack)` from the runtime root export
instead of indexing the raw payload. `PersistedLogEvent` in runtime-contracts describes the wire union. Unknown
versions, invalid references and unsupported graph values fail before resources or effects. Do not downgrade a run with
new graph checkpoints to an older runtime. This validates the graph/value transport; it is not a general migration or
repair tool for arbitrary edited run files. See [compatibility](../../docs/compatibility.md).

## AI health and safe recovery

The dispatcher adds no hidden deadline. Built-in executors default to twelve active
hours; configure the adapter timeout or an explicit `aiHost.deadlineAt` to override it.
Waiting for user answers does not consume the execution budget.
`aiHost` can set `monitoring` thresholds and observe task events. The engine forwards
health through `ExecutorContext.onAiEvent` into `ai_health` execution log events and
`RunComposition.onEvent`, correlated with node execution, task and attempt IDs.
Applications can forward these events to their own UI or logs. While a noncooperative
effect drains, the run remains running with explicit stopping/stalled AI health.
Resources are not released on a timer alone.

Structured executor failures retain `failure` metadata in `node_failed` and `run_failed`.
AI, Human and Code executor failures save the current frame stack as `suspended_state`.
`resumeRun` restores that checkpoint, including loop positions and variables; completed
steps and earlier Human answers are not executed again. The run uses its saved workflow
snapshot and original workdir. Fixing a script or input file in that workdir can therefore
repair the failed step; editing a library workflow does not silently replace the snapshot.

By default, `resumeRun` rejects `safeToReplay: false` before taking ownership or creating
resources. After the user reviews possible partial effects, pass `retryFailedNode` with
the current `run_failed.node_run_id` to explicitly retry that invocation. This token is
checked again under the run lock: stale requests, completed runs and concurrent workers
cannot replay later work. Automatic callers must never infer this user authorization.
Manual cancellation remains an abort. A crash or legacy abort without a final usable
checkpoint is not recoverable through this mechanism.

Provider messages and tool activity are recorded as `ai_progress` events. Output is bounded
per invocation (200,000 characters) and never contains synthesized progress or private
reasoning. Code validation failures can include bounded `diagnostics` (stdout, stderr,
exitCode and serialized rawOutputs). These are unvalidated evidence, never workflow values.
Explicit `on_failure` branches retain their existing routing semantics.

## Human adapters and durable results

`HumanExecutor` from `@openhilo/human-contracts` implements `id` and `present(task, host)`. Task fields include a stable
`taskId`, prompt, context inputs and output type declarations. `host.submit({ taskId, submissionId, outputs })`
validates and persists business results. Wire values are strings; declared types determine their runtime values.
Submitting continues the workflow; no submission leaves it waiting. Zero-field tasks explicitly submit `{}`.
Approval/refusal/revision are workflow-defined outputs, not protocol decisions. Obsolete `decision` payloads are
invalid; no migration is provided. AI model questions have a separate lifecycle.

Runtime publishes an immutable request plus a suspension checkpoint before calling an adapter. A notification error
emits `human_delivery_failed` and leaves the task recoverable. Successful submissions are atomically stored; identical
retries return `duplicate`, different results return `conflict`, and non-current tasks return `stale`. Adapters can
return immediately for deferred interaction. Their presentation signal ends when the presentation call settles.

For a deferred answer use `currentHumanTask(runDir)` and `submitHumanTask(runDir, submission)` from
`@openhilo/runtime/human-tasks`, then call `resumeRun` after an accepted or duplicate receipt **only while that task
remains current**. The embedding application coordinates presentation and resume. A later `resumeRun` can consume an
already saved result without receiving the fields again. Supply a new `humanExecutor` to `resumeRun` to redisplay an
unanswered task with the same ID. Legacy `humanOutput` remains supported; new integrations should send stable
task/submission IDs.

`human_submitted` records an accepted business result separately from delivery failure. A resumed execution attempt has
a new `node_run_id`; the task ID remains stable. State is recoverable only at a final suspension checkpoint. Local PID
locking still requires one host to coordinate concurrent resume attempts; atomic submission receipts do not turn
workflow side effects into distributed exactly-once transactions.

Run `node packages/runtime/examples/human-adapter.cjs` for a third-party adapter using only Runtime and contracts,
without Studio or any AI provider.

Large shared diagnostic values use `.graph.json` file references to avoid exponential JSON expansion; shared input debug
records may also contain the self-identifying `StateGraph`. Use `decodeStateGraph` for those files. Actual executor
inputs are unaffected. Durable Human/provider JSON wire contracts do not promise object identity;
see [compatibility](../../docs/compatibility.md).

Read models can import `decodeCheckpointStack` from `@openhilo/runtime/state-graph` to read saved call stacks with the
runtime codec, without loading executor/process modules. Do not assume persisted `call_stack` is an array.

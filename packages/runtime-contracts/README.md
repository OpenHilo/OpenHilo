# Runtime contracts

Public types and JSON boundary checks for optional runtime policies. This package has no database, subprocess, SDK or
domain application dependency. It reuses JSON and extension-state contracts from `@openhilo/ai-contracts`.

A `RuntimeExtensionPolicy` has a unique namespace and a positive integer version, a synchronous `derive` callback for
new frames, and a `restore` callback for saved frames. Callbacks receive copies of workflow data and their own parent's
state. They cannot access the engine stack. They are trusted application code, not sandboxed plugins.

`RuntimeExtensions` validates required workflow policies and copies state at boundaries. A generic registry returns an
empty context. Every saved extension needs a matching policy/version; adding a policy on resume also requires an
explicit migration. A pre-extension snapshot is accepted with configured policies only when the caller explicitly
enables legacy migration. Policies validate their own saved payload and must not silently recalculate it from defaults.
`resumeRun` also calls `restore` during its read-only preflight, so `restore` must be deterministic and free of side
effects. A missing or mismatched policy rejects that resume without changing the run.

The optional third executor argument carries `ExecutorContext`. Checkpoint frames record `extension_state`,
including an empty array for generic execution. The runtime passes these values into task requests as context. The
package does not assign any meaning to application fields such as business levels.

Build with `npm run build --workspace @openhilo/runtime-contracts`. Test with
`npm test --workspace @openhilo/runtime-contracts` after building workspace dependencies. Only local scripted policies
are used in tests.

The package also owns shared execution state (`Scope`, `ExecutionFrame`, `CheckpointFrame`), event/run records and
`AbortError` / `FailableError`. These reference ITT graph/value types and optional structured AI failure details. They
do not expose provider configuration or MCP transport objects. The `@openhilo/runtime` root entry
re-exports these error classes, preserving error identity across the two public packages.

`LogEvent` describes decoded in-memory events. `PersistedLogEvent` describes JSONL: checkpoint `call_stack` can be a
legacy frame array or a versioned `StateGraph`. Decode the entire stack with `decodeCheckpointStack` from
`@openhilo/runtime`; separate per-frame decoding cannot preserve cross-frame references. New graph checkpoints are not
readable by old runtimes.

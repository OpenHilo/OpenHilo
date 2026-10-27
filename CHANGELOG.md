# Changelog

## Unreleased

- Module compilation resolves shared non-generic JSON type aliases and relative
  `import type`. Expansion budgets apply per alias use, diagnostics point at the
  original source, and values may share names with aliases. Dynamic `import()`,
  optional workflow calls and `__proto__` object keys are rejected. Large modules
  no longer re-analyze the whole file for every function.
- Expressions run in a fresh isolated realm without host intrinsics, string code
  generation, Promises or dynamic import. Resume reuses checkpointed call inputs
  instead of re-evaluating them. Plain executor errors use failure routing; event
  observer errors, long runs and unusual input keys no longer corrupt records.
  Snapshots are validated before execution.
- **Behavior change:** Code subprocesses inherit only an allowlisted environment
  (PATH, HOME, locale and similar); pass credentials explicitly with `env`. Inputs
  that would override interpreter or loader variables are rejected. Process groups
  are stopped after completion and on host exit/signals; outputs survive user
  `trap ... EXIT`/`exec`; symlinked outputs must stay inside the workspace.
- The ITT validator returns errors for malformed graphs instead of throwing,
  handles deep graphs, and validates input shapes and loop exits. Legacy numeric
  inputs reject empty or non-numeric text. Studio descriptors reject unknown keys
  and plain-HTTP model endpoints outside loopback.
- AI SDK workspaces protect `.git` case-insensitively; Codex shutdown always
  escalates and cannot hang on inherited pipes; piped terminal input is no longer
  lost between Human tasks.

- Confirmed AI cancellation aborts the workflow after session cleanup and bypasses
  failure branches, including nested calls after Human resume. A cancelled run
  cannot fall back to an older Human checkpoint. Provider failures and active-time
  timeouts retain failure routing and explicit failed-step recovery.

- Local Code tasks support host-configured subprocess deadlines, AbortSignal
  cancellation and process-group termination with SIGTERM/SIGKILL escalation.
  Cleanup finishes before execution settles and the run lock is released.
- Captured stdout/stderr and serialized business results each have a default
  10 MiB budget. Hosts can raise these limits or opt out with `Infinity`.
  Limits fail the task rather than returning truncated business results; the runtime
  honors failure routing or saves a checkpoint for explicit retry.
  UTF-8 split across pipe chunks is preserved; file references use streaming hashes.
- Upgrade OpenAI/Anthropic SDKs, Ajv with explicit standard formats, TypeScript
  6, Jest and ts-jest. Build configurations use modern module resolution.
  See [dependency maintenance](docs/validation.md#dependency-maintenance) for
  compiler compatibility and the scoped coverage-tool dependency override.

## 0.1.0 — source distribution

- Twelve `@openhilo/*` packages for contracts, compilation, execution, tools and
  AI/Human/Code adapters. Use a source checkout or local package archives; npm
  packages are not published.
- A documented TypeScript workflow subset with branches, loops, destructuring,
  optional chains and named calls across source files. Unsupported syntax and
  invalid persistent values fail explicitly.
- Typed executor results and shared ordinary object/array references inside
  workflows, including nested calls and Human checkpoints.
- File-backed execution records and controlled Human pause/resume across
  processes, without replaying completed steps.
- Human adapters submit business results, with request identity, input validation
  and duplicate/conflict detection. The terminal adapter offers numbered choices.
- Codex CLI and OpenAI/Anthropic SDK adapters, structured results, questions,
  tool hosts, execution health and cooperative cancellation. SDK examples remain
  experimental pending live API validation.
- Local Bash/Python execution with typed inputs, file references and process results.
- Source examples for local reports, AI review, file drafting/revision, bounded
  script repair, SDK text and SDK tools.

See [validation](docs/validation.md) for tested environments and remaining limits.

# Changelog

## Unreleased

- Local Code tasks support host-configured subprocess deadlines, AbortSignal
  cancellation and process-group termination with SIGTERM/SIGKILL escalation.
  Cleanup finishes before execution settles and the run lock is released.
- Captured stdout/stderr and serialized business results each have a default
  10 MiB budget. Hosts can raise these limits or opt out with `Infinity`.
  Limits abort the task rather than returning truncated business results.
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

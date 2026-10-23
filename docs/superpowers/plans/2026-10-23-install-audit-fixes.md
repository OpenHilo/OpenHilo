# Installation audit fixes implementation plan

> Continue this plan task by task. Scope: implementation, self-testing and a local commit.

**Goal:** Fix the four reproduced runtime/Code defects and the installation/documentation inconsistencies found in the installation audit.

**Architecture:** Preserve public compatibility while enforcing executor output contracts. Serialize local run-lock transitions, revalidate recovery state under ownership, and retain read-only rejection of invalid recovery requests. No new runtime dependencies or live provider calls.

**Tech Stack:** TypeScript, Node 22/24, node:test, Python 3, Bash, local filesystem.

**Spec:** The installation audit in this conversation: concurrent resume duplicates effects; Python exceptions lose stream-only exit results; Bash semantics depend on output declarations; file/dir outputs accept the wrong kind. Documentation must reflect actual example capabilities and paths.

## Global constraints

- Preserve missing/invalid declared-output failures and the lower-level executeCode legacy shell default.
- Preserve existing PID lock files, safe-to-replay checks, immutable Human receipts, and cleanup-before-lock-release.
- Tests use temporary data and offline fixtures; do not read credentials or invoke live models.
- Commit locally on the repair branch. The user explicitly replaced the push request with local commit only.

## Review focus

- A stale contender must never remove a new owner's lock or replay an older Human checkpoint.
- A crashed/partial lock transition or an uninspectable PID must fail closed with actionable guidance.
- Python spawn failures must remain errors; ordinary process failure with no business outputs remains exit-code data.
- File/dir validation must handle empty, relative and absolute paths consistently without breaking valid file references.
- Legacy shell callers must retain their default while explicit Bash workflow nodes keep stable semantics.

## Task 1 Code executor contracts

Files: adapters/code-local/src/{process,dispatcher,types}.ts; adapters/code-local/test/process-contracts.test.cjs; adapters/code-local/README.md.

- [x] Add regressions for ordinary Python exceptions/SyntaxError/signals with stream-only results, valid and missing business outputs, stable Bash semantics with/without a business output, and both file/dir mismatch directions in Bash/Python.
- [x] Run `node --test adapters/code-local/test/process-contracts.test.cjs`; observe the reported defects before implementation.
- [x] Add an optional explicit shell setting to CodeExecutorConfig; dispatcher selects Bash explicitly and legacy direct callers retain their existing default.
- [x] Return Python stream results when no business outputs need decoding; retain existing declared-output validation.
- [x] Share Code path validation with an expected-kind check, normalized workspace paths and existing file-reference creation.
- [x] Build and rerun all Code tests plus example workflows. Update ABI comments and package documentation.

## Task 2 Local run ownership and recovery

Files: packages/runtime/src/{run-manager,run-service}.ts; packages/runtime/test/run-lock.test.cjs and test/support/run-lock-worker.cjs; docs/execution-model.md.

- [x] Add deterministic real-process competition tests for an absent lock and a dead-owner lock; assert one successful owner and one business effect.
- [x] Cover invalid PID records, permission-denied probes, stale manager release, and recovery-state changes between preflight and lock acquisition.
- [x] Run the new tests against the original implementation and record the expected failures.
- [x] Serialize lock acquisition/reclamation using an exclusive short-lived coordination directory, create PID locks exclusively, track ownership, and fail closed for incomplete transitions.
- [x] Keep invalid-recovery preflight read-only; repeat validation while holding the lock and accept Human input only under that ownership.
- [x] Run runtime recovery, Human adapter, replay-safety and integration tests. Document interrupted coordination recovery.

## Task 3 Installation and documentation clarity

Files: docs/{quickstart,troubleshooting,validation,embedding,execution-model}.md; examples/model-routing/README.md; .nvmrc.

- [x] Correct offline/resume example lists, full runDir placeholder and seven-consumer count.
- [x] Add Node 24 selection metadata and environment-check commands.
- [x] Supply a complete copyable embedding starter and a small terminology table; run the starter with a fresh temporary workspace.
- [x] Check documentation links and commands. No tests that merely grep human prose.

## Task 4 Verification review and local commit

- [x] Run `npm test`, `npm run test:types`, `npm run check:boundaries`, `npm run check:packages -- --pack`, `npm run check:notices`, `npm run test:semantics`, and `npm run check:consumers`.
- [x] Repeat the independent installation walkthrough and focused bug probes using the new real-process lock regressions for the changed lock boundary.
- [x] Obtain one independent whole-change review and address substantive findings with regressions.
- [x] Commit the verified changes on `codex/fix-runtime-code-reliability`; verify the local SHA and clean working tree.

## Execution notes

The dedicated checkout was clean at 3f44cd1. It already has the supported Node 24 installation and a passing 967-test baseline from the preceding audit. Work proceeds on a repair branch in this checkout. General cancellation/output-cap features and dependency upgrades are outside the reproduced defects; this change adds no new runtime dependencies.

Focused verification: 40 Code/example tests and 48 Runtime/recovery tests passed after observing the new regressions fail before implementation. A concurrent resume previously consumed Human input even when lock acquisition failed; the existing cleanup test now verifies that rejection leaves the answer unsubmitted and explicitly supplies it on retry. A stale implicit answer is rejected if another owner advances to a different Human task before lock acquisition.

Independent review found an additional interleaving between task lookup and checkpoint rehydration, reproduced with a real advancing child process. Preflight now rejects inconsistent task identities and pins implicit answers to the original submission task. The contention test sends its completion signal only to the winning process to avoid racing the rejected worker’s IPC disconnect. Full regression caught an async-frame retention of the old checkpoint; returning the execution promise with final cleanup rather than awaiting it inside the preparation frame restores the existing memory-lifecycle guarantees. The original memory probe now passes without changing its expectations.

Completion verification on 2026-10-23, using Node 24.22.1 in the relocated checkout: `npm test` passed all 890 Node tests and 104 Jest tests (994 total). Type checks, package boundaries, all twelve real package archives and fourteen dependency notice artifacts passed. The complete embedding starter printed `{"doubled":42}` and completed; seven changed documentation files had no broken local file links. Independent acceptance passed eleven Code probes, the Python error-handling workflow, and six installation/recovery walkthrough scenarios, including revision without replaying the initial draft.

The workspace-level activation and demo scripts were also updated to resolve their own directory after the workspace move; Bash and Zsh activation and the offline demo passed from outside the checkout. These helpers and audit evidence live beside this Git repository. Current evidence is in `../audit/completion-*`; interrupted runs and the sandbox DNS failure are preserved separately from completed retries.

The separate `npm run test:semantics` run passed 85 tests, including the unchanged memory-lifecycle probes. `check:consumers` passed all seven isolated installations, archive runtime checks and public type checks after retrying with registry access. No live provider calls were made.

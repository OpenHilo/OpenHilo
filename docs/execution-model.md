# Execution model

1. **Compile.** `compileProgram` receives virtual TypeScript source files, explicit
   exported entries and optional system method declarations. It produces ITT v2
   implementations, declarations and source locations. Named relative imports are
   resolved within that closed source graph. Compilation performs no model work.
2. **Snapshot.** The host persists all artifacts under their qualified IDs and
   supplies a complete snapshot to `startRun`. Private functions and imported
   functions need their artifacts too. The snapshot is the version this run uses.
3. **Execute.** Runtime follows branches, loops and nested workflow calls. The
   dispatcher sends leaf work to the explicitly supplied AI, Code or system port;
   Human nodes use the Human adapter lifecycle. There is no implicit AI provider.
4. **Observe.** Hosts receive node events and AI health correlated with run/node,
   task and attempt. JSONL logs preserve those events. AI health distinguishes
   starting, model work, tools, waiting for an answer, stopping and cleanup.
   `slow` is elapsed-time based; `stalled` indicates lack of progress. Silence from
   an unresponsive host process is not proof that a model is still healthy.
5. **Decide and recover.** Human requests are persisted before presentation.
   Terminal adapters may answer immediately; a notification adapter can return
   and leave the run suspended. Resume the exact run directory with a valid saved
   business result or adapter. Do not recompile current source over an existing snapshot.

## Human and AI questions are different

A Human node has a durable task ID, typed string-wire fields and immutable
submission receipts. A repeated submission is duplicate or conflict; a previous
round's task cannot advance the next round. Submit `taskId`, `submissionId` and
`outputs`; there is no fixed confirm/reject decision. A boolean business output
such as `approved: 'false'` is valid, and the workflow chooses its branch.
Missing or invalid required outputs leave the task waiting; an empty string is
valid for a text output. A zero-output task still needs an explicit submission
with `outputs: {}`. EOF, Ctrl+C or closing a UI without submitting is not a result.

An AI executor can ask a temporary clarification on its current `AiExecution`.
Use that handle's `answer`, not the Human task API. The interactive review example
shows numbered choices when supplied. The noninteractive SDK examples explicitly
cancel an unexpected question instead of waiting for an unavailable person.

## Execution grants and cleanup

A direct SDK task can omit workspace and business tools. Internal completion and
question functions are part of its provider protocol. Current Runtime AI nodes
receive a workspace through the dispatcher; using an SDK there does not imply
text-only capability. `createToolHost` registers explicit handlers and validates
arguments, but schemas and `readOnly` labels are not a security sandbox.

Codex controls its own child process and configured CLI sandbox. Host tools and
`code-local` are separate execution channels and retain host permissions. Bash
and Python run locally and may read/write accessible files or use the network.
There is no implicit container, UID isolation or permission approval service.

Cancellation requests stop work; they do not prove cleanup has finished. An active
noncooperative tool keeps the attempt in stopping and resources remain owned until
settlement. SDK and Codex limits bound model turns/time, not arbitrary host code.
Code execution has its existing exit-code-as-data behavior: check `exit_code`
before declaring success, as the report examples do. Runtime does not promise
that stopping an AI child cancels every external effect.

## Recovery limits

Controlled Human checkpoints preserve the original snapshot, scopes and completed
steps. Incomplete terminal log records do not revive an older checkpoint. Live
local PID locks prevent a second local resume. These are not distributed leases.

Failures carrying `safeToReplay: false` cannot be resumed automatically. A tool
may have committed an effect before disconnecting: inspect its external outcome
and use application-owned idempotency before attempting new work. Neither a
successful retry nor a cancellation can establish exactly-once delivery on its
own. Do not route an uncertain write into an automatic retry loop.

AI session continuation is separate from workflow recovery. Sessions belong to an
executor/profile/workspace identity; mismatches are rejected. SDK sessions are
in memory, not reconnectable across arbitrary process loss. The review example
starts fresh AI attempts after Human recovery and never promises cross-provider
session migration. Release optional session resources when supported and no longer
needed. See [embedding](embedding.md) for public interfaces.

## Variable lifetime and value boundaries

Compiled workflows resolve block/loop bindings by source symbol. Inner
bindings do not overwrite outer names. ITT v2 assignment nodes clear
exited local values, including break/continue paths; unused expression and call
assembly temporaries do not retain their results. An existing suspended run
uses its saved snapshot; changing source affects only newly compiled runs.

Workflow state contains supported ordinary data with native reference semantics.
Assignments, internal workflow calls, shallow object copies and foreach targets
preserve shared objects. Checkpoints encode the whole call stack as one versioned
JSON graph, including all scopes and live loop arrays/cursors. Distinct objects
remain distinct even when their values are equal. Native memory addresses are
not part of this guarantee.

Host/executor data and observer events cross explicit ownership boundaries and
are copied as a whole payload. Scope writes and internal calls do not copy their
values. Unsupported persistent values are rejected, including frozen/sealed or
nonextensible objects, custom/null prototypes and nonordinary descriptors; the
runtime does not emulate those features. See [compatibility](compatibility.md)
for the data subset and natural differences in clocks, randomness and resources.

After restoring frames, Runtime drops the raw recovery graph so cleared values
are not pinned throughout a later Human wait. Standard run orchestration closes
resources on completion, suspension and failure, and releases the run lock even
when a resource close callback throws. V8 chooses actual collection timing;
closed scopes becoming unreachable does not require RSS to decrease immediately.

The offline semantics regression includes a fresh-process resume, repeated runs
with WeakRef/forced-GC evidence, and large loop-local values. Forced GC is confined
to an isolated test process; production does not force collection. These bounded
checks do not prove the absence of all leaks in arbitrary host adapters or workloads.

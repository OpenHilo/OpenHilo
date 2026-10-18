# Embedding the core

OpenHilo's compiler, runtime, AI and Human contracts are separate packages. Install
only the closure you need, following [local tarball installation](quickstart.md#embed-packages-from-local-tarballs).
The packages are not published to a registry.

The complete source examples are [local-report](../examples/local-report/README.md),
[review-report](../examples/review-report/README.md), [SDK text](../examples/sdk-text/README.md)
and [SDK tools](../examples/sdk-tools/README.md).
[Document review](../examples/document-review/README.md) demonstrates AI file
creation/editing, `FilePath` handoff and Human checkpoint recovery.
[Script repair](../examples/script-repair/README.md) demonstrates Code test reports
driving a bounded AI file-repair loop, with Code verifying the result.
These examples run locally without a server or database.

## Compile and assemble a run

`compileProgram` does no filesystem I/O. Give it a closed virtual source graph:

```js
const { compileProgram } = require('@openhilo/compiler');
const compiled = compileProgram({
  files: {
    'approval.ts': `
      declare function review_report_by_human(prompt: string): Promise<{ approved: boolean }>;
      export async function main(): Promise<{ approved: boolean }> {
        const choice = await review_report_by_human("Decide whether to approve this report.");
        return { approved: choice.approved };
      }`,
  },
  entries: [{ file: 'approval.ts', exportName: 'main' }],
});
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
// Persist each artifact's implementation, declaration and sourceMap under its id.
// The entry above is approval.main.itt.impl.json, not simply main.itt.impl.json.
```

The runnable [example compiler helper](../examples/lib/compile.cjs) shows file
loading, artifact naming and source retention. It is example code, not a
public package API. Preserve all dependencies in a run snapshot, including private
functions and imported modules.

`startRun` accepts a resource factory, input wire values and snapshot writer:

```js
const fs = require('node:fs');
const path = require('node:path');
const { startRun, resumeRun } = require('@openhilo/runtime/run-service');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const { createCodeExecutor } = require('@openhilo/code-local');
const { TerminalHumanExecutor } = require('@openhilo/human-terminal');

// entryFile/artifactsDir: validated compile output; workdir/runsDir: your new run paths.
const createResources = ({ runId, workdir }) => ({
  executor: createDispatcher({ runId, workdir, codeExecutor: createCodeExecutor(workdir) }),
  humanExecutor: new TerminalHumanExecutor(),
  // Add aiExecutor explicitly for workflows containing AI nodes.
});
const result = await startRun({
  intent: 'approval.main', entryFile, workdir, runsDir, inputs: {},
  inputEncoding: 'typed-text-v1', createResources,
  populateSnapshot: ({ snapshotDir }) => fs.cpSync(artifactsDir, snapshotDir, { recursive: true }),
  onEvent: event => console.log(event.event),
});
// Run this only when result.status is suspended:
const resumed = await resumeRun({ runDir: result.runDir, createResources });
```

The host owns paths and resources. It can return `close()` for cleanup. Input wire
values are strings; `typed-text-v1` preserves text and decodes JSON/number/boolean
against the workflow schema. Human executor errors such as EOF preserve a pending
request and return suspended; do not label that as successful approval.

## Run input encoding

For new hosts, set `inputEncoding: 'typed-text-v1'` on `startRun`. The wire object
contains strings; the frozen workflow input schema determines how each is decoded.
`validateRunInputWire` checks the transport shape only. `parseRunInputs` performs
the schema-based decoding that `startRun` uses before creating execution resources.

```js
const { parseRunInputs } = require('@openhilo/itt-contracts/run-inputs');
const schema = {
  count: { kind: 'number' }, enabled: { kind: 'boolean' },
  options: { kind: 'json' }, label: { kind: 'text' },
};
const raw = {
  count: '3', enabled: 'false', options: '{"topic":"garden"}', label: '  draft  ',
};
const inputs = parseRunInputs(raw, schema, 'typed-text-v1');
// { count: 3, enabled: false, options: { topic: 'garden' }, label: '  draft  ' }
// To start a run, pass inputs: raw and inputEncoding: 'typed-text-v1'.
// Do not pass the already-decoded inputs to startRun: it expects wire strings.
```

| Declared kind | Wire value and decoded result |
| --- | --- |
| `text` | Text is preserved, including empty strings and whitespace. |
| `number` | `'3'` or `'1e2'` becomes a finite number. Invalid suffixes, nonfinite values and negative zero fail. |
| `boolean` | Exactly `'true'` or `'false'` becomes a boolean; `'1'` is invalid in typed mode. |
| `json` | `'"garden"'` becomes a string; `'{"topic":"garden"}'` becomes an object. Bare `'garden'` is invalid JSON. Nonfinite numbers and negative zero fail, including nested values. |
| `file` / `dir` | A path string stays a string. This parser does not check existence, copy files or grant filesystem access. |

Typed mode requires every declared field and rejects unknown fields. Runtime also
checks its persistent-value contract; input parsing alone is not a sandbox.

Omitting the encoding retains compatibility conversion: numeric fields use
`Number`, boolean fields are true only for `'true'` or `'1'`, and JSON/text fields
remain literal strings. Missing fields and unknown extra fields are not rejected
by this legacy parser. Runtime still checks retained values afterward. New hosts
should opt into typed mode instead of relying on these coercions. Recovery uses
the saved values and does not reinterpret an old run with a new encoding; start
a new run to change its input encoding.

## Your own Human adapter

A `HumanExecutor` implements `id` and `present(request, host)`. It can display or
enqueue `request` in your application and later submit business outputs:

```js
const receipt = await host.submit({
  taskId: request.taskId,
  submissionId, // unique per logical user submission; reuse only for its retry
  outputs: { approved: 'false' },
});
if (receipt.status !== 'accepted' && receipt.status !== 'duplicate') {
  throw new Error(receipt.message ?? receipt.status);
}
```

Use the public types from `@openhilo/human-contracts`. Preserve the task ID and
round identity; never fill a new request with an old answer. For delayed delivery,
`present` may enqueue and return without submitting. Runtime saves the Human point
and exits suspended. Your new process then calls `resumeRun` with a matching
`humanSubmission`, or with a newly composed `humanExecutor` that presents the
current saved task. Do not recompile a newer workflow over its original snapshot.

The complete [existing adapter example](../packages/runtime/examples/human-adapter.cjs)
can be run with `node packages/runtime/examples/human-adapter.cjs`. It uses an
in-memory queue as an offline host illustration; it is not a persistent UI service.
The [review example](../examples/review-report/README.md) demonstrates actual
process exit and restoration from a saved run.

Submitting validated business outputs completes the human node. For example, `approved: 'false'` is a normal result that
your workflow handles with a branch. No submission leaves the task waiting; there is no separate confirm/reject
protocol. Zero-output tasks explicitly submit `{}`. Obsolete decision-bearing payloads are rejected, not migrated.

## AI execution independent of Runtime

An `AiTaskExecutor` implements `start(request, host)` and declares capabilities.
Accepted work returns an `AiExecution` with `result`, `answer` and `cancel`.
Observe health events as well as the final result; cancellation means stopping
until cleanup settles. Release idle session references when finished. An old
session cannot be continued with a mismatched executor/profile/workspace.

SDK text tasks can call that interface directly without business tools or a
workspace. See [the example SDK host](../examples/lib/sdk.cjs). Internal completion
and question tools remain part of the provider protocol. The current Runtime
dispatcher supplies a workspace to workflow AI nodes; these are different grants.
Tools are explicitly registered handlers, not arbitrary names the model invents.

Code executes with host privileges. Tool schemas and CLI sandbox settings do not
sandbox other host channels. Do not run untrusted workflow source. Current safe
recovery is based on validated Human checkpoints and known replay boundaries,
not a claim of arbitrary crash recovery or exactly-once external effects.

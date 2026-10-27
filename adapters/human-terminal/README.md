# @openhilo/human-terminal

`TerminalHumanExecutor` displays a Human task's prompt, inputs and declared output types, collects its business outputs,
then submits the complete result. Boolean fields use numbered `1. Yes` / `2. No` choices. Other fields accept typed
text. Tasks with no output fields require the explicit numbered `1. Completed` choice. Blank menu input never submits.

```ts
import { TerminalHumanExecutor } from '@openhilo/human-terminal';

const humanExecutor = new TerminalHumanExecutor();
// Configure the executor on your Runtime host.
```

Every declared output field is collected directly. The adapter does not invent business actions, prefill other fields,
or infer what a field means. A workflow can branch on the submitted values. String inputs are displayed as readable
text, retaining their line breaks.

Invalid numbers or JSON and invalid menu choices are requested again. Text whitespace is preserved. Each submission
contains only `taskId`, a generated UUID `submissionId`, and `outputs`. Accepted and duplicate receipts complete
normally; invalid, stale or conflicting receipts throw a descriptive error.

EOF and cancellation close the presentation without inventing a result, leaving an unsubmitted task waiting. In an
interactive terminal Ctrl+C reports an `AbortError` identifying `SIGINT`. Cancellation also settles a pending prompt or
receipt, but cannot retract a submission already delivered to the host; the host remains authoritative.

All tasks presented by one executor share a single stdin line reader, so lines piped or typed ahead are queued for the
next prompt instead of being dropped between tasks. Stdin is paused (and a TTY returned to cooked mode) while no task is
reading, so it does not keep the host alive. Call `executor.close()` (or use `using`) to release stdin permanently.

`TerminalHumanExecutorOptions` also accepts `promptFn(prompt, signal?) => Promise<string>` and `write(text) => void` for
embedding. An injected prompt should release its own resources on cancellation; the adapter settles even if that prompt
ignores its signal. The default executor ID is `terminal`.

Build with `npm run build --workspace @openhilo/human-terminal`; run `npm test --workspace @openhilo/human-terminal`
after building dependencies. Tests include real subprocess checks for numbered results, whitespace, EOF and
cancellation.

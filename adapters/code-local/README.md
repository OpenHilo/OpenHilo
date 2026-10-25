# @openhilo/code-local

Local Bash and Python execution for ITT workflows. This adapter preserves typed inputs, declared outputs, workspace file
references and stdout/stderr/exit status. It does not load an AI provider, account configuration or application policy.

```js
const { createCodeExecutor } = require('@openhilo/code-local');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const controller = new AbortController();
const executor = createDispatcher({
  workdir,
  codeExecutor: createCodeExecutor(workdir, {
    timeoutMs: 60_000,
    maxOutputBytes: 10 * 1024 * 1024,
    maxResultBytes: 10 * 1024 * 1024,
    killGraceMs: 1_000,
    signal: controller.signal, // a host-owned AbortController
  }),
  aiExecutor,   // an explicitly supplied AiTaskExecutor
  sysExecutor, // an explicitly supplied runtime ExecutorFn
});
```

Pass the resulting executor to the runtime engine or run-service resource factory. `executeCode` and `executePython`
expose the lower-level process API; `CodeExecutionResult` is separate from the AI task result. `ExecutionError` shares
the runtime-contracts implementation with legacy callers.

Bash receives environment values; Python receives JSON values as globals, preserving numbers, booleans and objects. File
references become workspace paths. Declared outputs are validated and converted to ITT values; `stdout`, `stderr` and
`exit_code` are reserved stream outputs. A nonzero process status is returned as data rather than automatically thrown;
invalid or missing declared outputs fail. Signal exits use 128 plus the signal number, and Python `SystemExit` retains
its exit status.

When a Python node declares only stream outputs, ordinary exceptions and syntax
errors also return their nonzero `exit_code` and traceback in `stderr`; workflow
code can branch on that result. If business outputs are declared, missing or
invalid values still fail instead of inventing a result. File and directory
outputs must exist with the declared filesystem kind; an empty path is invalid.

Bash workflow nodes always execute with Bash, regardless of the declared outputs.
Direct `executeCode` callers can pass `shell: 'bash'` or `shell: 'sh'`. Omitting
`shell` preserves the legacy choice: Bash with business outputs, otherwise sh.

## Timeouts, cancellation and output limits

The second argument of `createCodeExecutor(workdir, options)` configures every
Code task created by that executor. The same options are accepted directly by
`executeCode` and `executePython`. The previous second-argument form containing
injected `executeCode`/`executePython` implementations remains supported; new
callers can supply implementations as a third argument.

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | Unset | Positive integer subprocess deadline in milliseconds, including waiting for inherited stdout/stderr pipes; maximum 2,147,483,647. Set it explicitly for unattended workflows. |
| `signal` | Unset | Host `AbortSignal`. A pre-aborted signal prevents launch. Reusing an aborted signal cancels future calls too. |
| `killGraceMs` | 1,000 | Nonnegative integer delay between SIGTERM and SIGKILL; zero requests immediate escalation. Maximum 2,147,483,647. |
| `maxOutputBytes` | 10 MiB | Combined stdout and stderr **bytes**, not characters or separate per-stream allowances. Zero permits no output; `Infinity` opts out. |
| `maxResultBytes` | 10 MiB | Serialized business-output protocol file size, including field names and encoding overhead. Zero permits no bytes; `Infinity` opts out. |

These defaults introduce finite output budgets for existing callers. Increase
the relevant limit for known large payloads. Limits must be nonnegative safe
integers or `Infinity`; invalid configuration is rejected before launch. UTF-8
characters split across pipe chunks are decoded correctly.

Timeout, cancellation and output-limit failures reject with `CodeProcessError`,
an `AbortError` subclass. Its `reason` is `timeout`, `cancelled`, `output_limit`
or `result_limit`. Bounded `stdout` and `stderr` are diagnostics only; no typed
business outputs are returned from a stopped task. The low-level process API retains this error type. `createCodeExecutor` adapts repairable
execution and output-validation errors to a checkpointed runtime failure requiring an
explicit retry; host cancellation still aborts. Failed-attempt diagnostics include bounded
stdout/stderr, exit code and available unvalidated output fields. No automatic replay occurs. This differs from a script's
ordinary nonzero exit, which remains `exit_code` data. Termination does not roll
back filesystem writes, network requests or other effects already performed.

On macOS/Linux, tasks run in a separate process group. Stops send SIGTERM to the
group, then SIGKILL after the grace period, including descendants whose parent
has exited. Group cleanup and cancellation remain active during the bounded
result-file read, including limits discovered after the direct child exits.
The promise settles after the direct child closes, result reading and escalation
have finished and protocol files have been removed; Runtime retains its lock until
that cleanup settles. Timers and abort listeners are removed after each call.
Descendants that deliberately create another session/process group escape this
mechanism; Windows process-tree termination is not guaranteed or verified.

Because Code uses a separate process group, terminal SIGINT does not reach it
automatically. Hosts must forward their cancellation signal through the `signal`
option. The shared interactive example host does this for Ctrl+C.

The result file is size-monitored while the subprocess runs and read with a
bounded reader after exit. Monitoring is not an OS disk quota and may overshoot
between checks. The deadline covers the subprocess, not host-side input
serialization, output parsing or file hashing. File/Dir outputs reference
workspace artifacts: their contents are not subject to `maxResultBytes`, and
file-reference hashes are computed with streaming reads. These controls do not
impose a CPU, total child memory or filesystem quota.

Requires Node.js, Bash and Python 3 on the host. The build copies `_itt_runner.py` into `dist`; the packed package
includes it. Run `npm test --workspace @openhilo/code-local` after building dependency workspaces. Tests use temporary
directories, local subprocesses and a fake AI executor; no accounts or model services are contacted.

This is a trusted local-code adapter, not an isolation sandbox. Processes inherit the existing host environment and
permissions. Remote execution and isolation are not supplied by this adapter.

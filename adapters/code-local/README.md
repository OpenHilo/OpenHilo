# @openhilo/code-local

Local Bash and Python execution for ITT workflows. This adapter preserves typed inputs, declared outputs, workspace file
references and stdout/stderr/exit status. It does not load an AI provider, account configuration or application policy.

```js
const { createCodeExecutor } = require('@openhilo/code-local');
const { createDispatcher } = require('@openhilo/runtime/dispatcher');
const executor = createDispatcher({
  workdir,
  codeExecutor: createCodeExecutor(workdir),
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

Requires Node.js, Bash and Python 3 on the host. The build copies `_itt_runner.py` into `dist`; the packed package
includes it. Run `npm test --workspace @openhilo/code-local` after building dependency workspaces. Tests use temporary
directories, local subprocesses and a fake AI executor; no accounts or model services are contacted.

This is a trusted local-code adapter, not an isolation sandbox. Processes inherit the existing host environment and
permissions. Cancellation, time limits and remote execution are not supplied by this adapter.

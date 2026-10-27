# Shared tool host

`@openhilo/tool-host` implements the `ToolHost` port from `@openhilo/ai-contracts`.
It depends on the contracts and Ajv, with no provider, database, domain application,
MCP process or filesystem dependency. Your embedding application supplies handlers.

```ts
import { createToolHost } from '@openhilo/tool-host';

const host = createToolHost([{
  name: 'lookup',
  description: 'Read a record by ID',
  inputSchema: {
    type: 'object', properties: { id: { type: 'string' } },
    required: ['id'], additionalProperties: false,
  },
  readOnly: true,
  async handler(args, { signal }) {
    return repository.lookup(args.id as string, signal);
  },
}]);
// Supply host as ExecutionHost.tools to an executor supporting tools.
```

`createToolHost(tools)` accepts `RegisteredTool` entries (a `ToolDefinition` plus
`handler(args, {callId, signal})` and optional `readOnly`). The top-level schema must
have `type: 'object'`. Schemas use synchronous JSON Schema draft-07, compiled at registration. Unknown
keywords/formats, async schemas and duplicate tool names fail early. Arguments are checked
without coercion, default insertion or property removal; output must be JSON.
Ajv 8 performs validation, with `ajv-formats` preserving standard formats such
as email and date; invalid calendar dates are rejected. Unsupported draft-04
schemas must be migrated to draft-07 before registration.
Definitions, arguments and successful results cross the boundary as copies.
Schemas and handlers are trusted application code, not an untrusted-code sandbox.

Cancellation before dispatch prevents invocation. After dispatch the handler
receives the signal and the host awaits its completion/cleanup; it cannot forcibly
stop a handler that ignores cancellation. Late success remains authoritative.
Handler failure is `tool_failed` with `safeToReplay: true` for explicitly read-only
operations, otherwise `outcome_unknown` with `safeToReplay: false`. Invalid output
(`invalid_output`) follows the same rule: replayable only after a read-only handler.
Envelope, unknown-tool and argument-validation failures are `invalid_request`, and
cancellation before dispatch is `tool_failed`; these never reach a handler and are
`safeToReplay: true`. All failures have `retryable: false`. No failure triggers an
automatic retry. `readOnly` is the registering application's declaration (see
[SECURITY.md](../../SECURITY.md)); the host cannot verify it.

`callId` is correlation metadata. This registry does not deduplicate calls or
provide exactly-once execution. Persisted side effects need application-owned
idempotency/receipts before any higher layer can safely retry them. Transport
bridges must preserve uncertainty on disconnect instead of replaying queued writes.

Business catalogues belong to the embedding application. SDK and Codex task execution can consume the same host.
Per-task IPC bridges
retain separate lifecycle and cancellation responsibilities in the concrete
adapter; the generic host has no IPC dependency.

Run `npm test --workspace @openhilo/tool-host` from the repository root.

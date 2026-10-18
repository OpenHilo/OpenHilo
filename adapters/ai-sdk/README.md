# SDK task executor

`@openhilo/ai-sdk` implements `AiTaskExecutor` with one shared task loop and two
native model adapters: OpenAI Responses and Anthropic Messages. It imports only the
AI contracts, shared tool host and SDKs. It has no Claude Code process, tmux, MCP,
database, domain app or repository configuration dependency.

```ts
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { SdkTaskExecutor } from '@openhilo/ai-sdk';

const executor = new SdkTaskExecutor({
  defaultProfile: 'general',
  profiles: {
    general: {
      provider: 'openai', model: process.env.OPENAI_MODEL!,
      client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    },
    alternate: {
      provider: 'anthropic', model: process.env.ANTHROPIC_MODEL!,
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    },
  },
});
```

Model names and clients are explicit configuration. `TaskRequest.profile` selects
a configured profile; unknown profiles fail before a request. Public task data and
session references contain no credentials. Both clients are the official SDK
instances, so callers can configure supported endpoints or custom transports.

## Task semantics

- The model can invoke `ExecutionHost.tools`; their handlers actually run. Arguments
  and outputs must be JSON. The supplied host owns schema validation/application
  policy. Embedding hosts can use `@openhilo/tool-host` for that validation.
- `ask_user` connects to the normal question event and execution answer handle.
  Free-form answers, JSON answers and exclusive/suggested options use the public
  contract. Tool results retain their native provider call IDs.
- A local `file:` workspace enables `workspace_read`, `workspace_list` and
  `workspace_write`. Writes create parents and replace files via a temporary file
  and rename. Read/write content is limited to 1 MiB/1,048,576 characters. Tools
  reject paths outside the root, symlink traversal and `.git` metadata. These path
  checks are not a hostile-filesystem sandbox against concurrent directory swaps.
- `finish_task` must be alone in its turn. Its declared fields are validated;
  file/directory outputs must exist inside the workspace and yield artifact URIs.
  Text-only responses, truncation and mixed finish/action batches fail explicitly.
- Supplied tools cannot shadow the five reserved names above. Portable tool names
  use letters, digits, `_` or `-`, up to 64 characters. Server-executed provider
  tools, shell execution, images and streaming are not exposed by this adapter.

Tools run sequentially even when a provider returns several calls. All results are
returned in their provider's required format. Native OpenAI output/reasoning items
and Anthropic content/signatures remain in their adapter-owned histories. The
shared loop never converts the native conversation into a generic text transcript.

SDK automatic retries are disabled per request. A safe validation/read failure is
returned to the model so it can correct the call. An uncertain tool side effect
ends the task; the executor does not ask the model to retry the write. Accepted
call IDs cannot be executed twice in a retained conversation. This is not durable
business idempotency and cannot detect the same operation under a different ID.
Authentication, quota, rate limit, timeout and output failures remain distinct.

Cancellation/deadlines propagate to SDK requests and tools. Task settlement waits
for cooperative cleanup; handlers that ignore their signal can delay cancellation.
Usage reports provider-supplied token counts without estimating cost. Missing
measurements remain unknown; per-turn usage events retain available observations.

## Continuing and releasing context

Successful tasks return an opaque local session reference. Pass it as
`continuation` to append compiler feedback or further work. Profile and workspace
identity must match; a session permits only one active attempt. Completed
`finish_task` calls also receive native tool acknowledgements so subsequent history
remains well formed. Failed/cancelled attempts discard their context.

Call `releaseSession` when finished. Default limits are 32 model turns and 128 tool
calls per attempt, plus 128 retained sessions per executor instance. Runtime one-shot nodes release results
automatically; a custom host retaining
context is responsible for releasing it after its own review/repair lifecycle.

Continuation is in-memory only. This executor does not claim `reconnect`, arbitrary
crash recovery or enforceable dollar budgets. Such required capabilities fail
before execution. File edits already made are not rolled back by cancellation.

Deployments may provide `id` in `SdkExecutorOptions`, or pass `{ id }` as the third
argument to `createSdkTaskExecutor`. It defaults to `openhilo.ai-sdk`. The identity
is carried in session references and checked on continuation/release. Use a stable,
versioned identity over non-secret configuration when persisted runs/reviews must
reject changed provider selections; never include credentials. Source examples
`examples/sdk-text` and `examples/sdk-tools` demonstrate direct execution without a server.

## Validation and sources

From the repository root:

```sh
npm run build:packages
npm test --workspace @openhilo/ai-sdk
```

Tests instantiate both official SDKs with local scripted `fetch` responses. They
exercise requests, native conversation preservation, host tools, actual temporary
files, clarification, cancellation, error mapping, and continuation. The source SDK examples also verify typed
completion and a
registered catalog lookup.
There are no paid model calls in these tests; live provider validation is separate.

API references checked for this implementation:
[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls),
[Anthropic TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript).
Pinned SDK types: OpenAI 6.32.0 and Anthropic 0.128.0.

## Legacy JSON completion compatibility

`@openhilo/ai-sdk/legacy-json-executor` exports `LegacyJsonCompletionExecutor({base_url, api_key, model})`. This
separate compatibility entry implements the shared task contract for hosts using Chat
Completions and a single JSON output field. It retains the prior read-only completion retry/timeout behavior and
supports cancellation; it does not expose workspace tools or retained sessions. New SDK task deployments continue to use
`createSdkTaskExecutor` and the OpenAI/Anthropic task loop. The compatibility entry does not read global configuration
or import a domain application.

The direct source examples are experimental: official-SDK protocol fixtures pass for both providers; paid online model
acceptance is pending. They are not included inside this package tarball.

# SDK with one explicit business tool (experimental)

The host reads [catalog.json](catalog.json), registers a read-only `lookup` tool,
and asks the selected model to look up one record and summarize it. There is no
platform database or general workspace access. **Both providers passed local
protocol fixtures; live API behavior has not yet been verified.**

From the source root, install/build as in [SDK text](../sdk-text/README.md), configure
the selected provider's API key and model in the same shell (no automatic `.env`
loading), then run **one** of these from the repository root:

```sh
node examples/sdk-tools/run.cjs --provider openai --catalog examples/sdk-tools/catalog.json --id garden
node examples/sdk-tools/run.cjs --provider anthropic --catalog examples/sdk-tools/catalog.json --id library
```

These commands cost API usage. No default provider/model or implicit fallback is
used. Each catalog entry has unique string `id`, `title`, and `description` fields.
Copy the sample and edit it for your own small dataset. A missing item is returned
as `found: false`, not silently invented or read from another data source.

`createToolHost` validates `lookup({ id })` without coercion or extra parameters.
Unknown tools do not reach the handler. A summary is not accepted unless the
requested item was actually looked up. Tool errors remain visible to the task;
repeated calls hit the example's four-turn/four-call bounds. This is a read-only
lookup example, not an exactly-once transaction API or a sandbox.

The SDK receives only the registered tool and its schema, plus the adapter's
internal completion/question protocol. It does not receive the entire catalog
as a prompt or a general file reader. The handler runs under the host's permissions.
If you replace it with a mutating service, you must design its authorization and
idempotency explicitly; `readOnly: true` is metadata, not enforced isolation.

On success, exit 0 and `outputs.summary` in stdout describe the selected item.
No output directory or file is created; progress goes to stderr. The text is model
generated and may vary. To test a missing record, use an ID absent from your
catalog; a successful summary should state that it was not found.

Output, lifecycle, unexpected-question behavior, credentials and limits are the
same as the [text example](../sdk-text/README.md). Both examples ship with source;
no claim is made that they are embedded in an individual npm archive.

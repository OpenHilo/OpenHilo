# Package names and compatibility

Packages use the `@openhilo/*` scope. The compiler command is `openhilo-compile`.
Compiled workflows use ITT v2 with `.itt.json` and `.itt.impl.json` files.
Upgrade compiler, contracts and runtime together; see [compatibility](compatibility.md)
for supported values and recovery boundaries.

## Executor and tool identifiers

Default executor IDs are `openhilo.codex`, `openhilo.ai-sdk` and
`openhilo.legacy-json-completion`. Codex registers `openhilo_ask_user` and
`openhilo_tool_<index>` and initializes with client name `openhilo` and display
title `OpenHilo`. SDK artifact origin is `openhilo.ai-sdk`.
[`naming-compatibility.json`](naming-compatibility.json) lists any remaining
pre-rename identifier exceptions. It is empty: no old runtime identifiers are
accepted, and the naming test fails on an undocumented old identifier.

## Session continuation and checkpoint recovery

AI continuation requires a matching executor, profile, workspace and active
session. It does not provide cross-provider continuation or process-independent
SDK sessions. Mismatches are rejected before another model request. Do not rewrite
saved session identifiers to force continuation: inspect prior effects and start
a new AI task when necessary. Unknown external side effects are not automatically
replayed.

Human-node recovery uses saved workflow checkpoints and has a separate lifecycle
from AI sessions. Human submissions contain business outputs only; unsupported
`decision` payloads are rejected. See [Human contracts](../packages/human-contracts/README.md)
and [execution model](execution-model.md).

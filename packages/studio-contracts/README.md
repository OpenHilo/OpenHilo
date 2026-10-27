# @openhilo/studio-contracts

JSON presentation contracts and parsers for an embedding application. This package
contains no Studio UI, HTTP routes, Class/Entity store or renderer. It has no React,
server, storage, AI or domain dependencies. CommonJS and ESM consumers use the same
public entry point.

```ts
import { parseStudioApplication } from '@openhilo/studio-contracts';

const descriptor = parseStudioApplication({
  version: 1,
  id: 'laboratory',
  title: 'Laboratory',
  classFacet: {
    tag: 'stage',
    values: [{ value: 'review', label: 'Review', tone: 'green' }],
  },
  classFilterTags: ['region'],
  tags: { status: { tone: 'sky', inlineEditable: true } },
});
```

The descriptor expresses presentation choices for an application-owned renderer:
`classFilterTags` omitted means all schema-defined filters, while an empty array
means none; `classFacet` describes optional grouped navigation. Palette tokens
name renderer-defined colors, not arbitrary CSS. `inlineEditable` is presentation
metadata, not authorization; the application must supply and validate update handlers.
The parser validates and copies the descriptor. It does not render these behaviors.

The embedding application supplies tag definitions, data constraints, rendering
and transport. An application may expose `/api/application` and `/api/tag-definitions`,
but those routes are external integration conventions, not routes provided or
required by this package. Invalid descriptor versions, shapes or unknown fields fail explicitly.

`GENERIC_STUDIO_APPLICATION` contains no business rules. An embedding
application supplies its own descriptor. This package does not install
application data, manage application lifecycle, or register arbitrary pages.

Build/test: `npm test --workspace @openhilo/studio-contracts` from the workspace.

The `./ai-config` subpath provides the serializable Studio deployment selection and its strict parser
(`parseAiExecutionConfig`, which throws `AiExecutionConfigError`, plus the types `AiExecutionConfig`,
`DirectAiExecutionConfig`, `CodexExecutionConfig`, `RoutedExecutionConfig` and `SdkProfileConfig`).
It contains no SDK, credentials or runtime services.
Both CommonJS and ESM entries are supplied; no server configuration implementation is included.

### AI configuration does not install an executor

`parseAiExecutionConfig` validates configuration data; it does not construct, select
or launch a provider. The application maps supported selections to its own resources:

| Selection | Implementation supplied in this repository |
| --- | --- |
| `codex` | `@openhilo/ai-codex`, using a separately installed/authenticated Codex CLI |
| `sdk` | `@openhilo/ai-sdk`, using explicitly configured OpenAI/Anthropic SDK clients |
| `routed` | A `codex` or `sdk` configuration per type/level cell, dispatched by `configureAiRouting` from `@openhilo/ai-contracts/routing` (see [AI routing](../../docs/ai-routing.md)) |
| `claude-code` | **None. External-application compatibility configuration only.** |

`{ adapter: 'claude-code' }` remains accepted so external applications can read
existing configuration. It does not imply a bundled Claude Code executor, CLI
launcher, account manager or fallback. A host without that external implementation
must report that the selection is unavailable. Anthropic SDK support is separate
from Claude Code support.

An absent configuration returns `undefined`; the parser does not choose Claude
Code or any other default. Malformed explicit configuration throws. Credentials
are not stored in this object; SDK fields name environment variables, and the
embedding host owns credential loading and provider construction.

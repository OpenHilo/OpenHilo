# AI type and level routing

AI declarations may select a configured task type and level:

```ts
/** @ai.type coding
 * @ai.level pro
 */
declare function implement_change_by_ai(
  role: string, prompt: string, specification: string
): Promise<{summary: string}>;
```

Supported types: `default`, `general`, `reasoning`, `coding`, `writing`, `search`.
Levels: `light`, `medium`, `pro`, `max`. Both tags are optional; duplicates,
invalid values and tags on non-AI declarations are compiler errors. Ordinary
`@tags` and `@entry` metadata retain their existing meaning. Calls keep the same
role, prompt and business parameters.

| Declaration | Selection |
| --- | --- |
| No tags | default / its defaultLevel |
| Type only | that type / its defaultLevel |
| Level only | default / that level |
| Both | exact type / level |

## Configure one execution target per cell

```json
{
  "adapter": "routed",
  "routes": {
    "default": {
      "defaultLevel": "medium",
      "levels": {"medium": {"adapter": "codex", "effort": "low"}}
    },
    "search": {
      "defaultLevel": "light",
      "levels": {
        "light": {
          "adapter": "sdk",
          "default_profile": "main",
          "profiles": {
            "main": {"provider": "openai", "model": "YOUR_MODEL", "api_key_env": "OPENAI_API_KEY"}
          }
        }
      }
    }
  }
}
```

`default` and each group's `defaultLevel` must exist. Missing explicit routes are
errors. There is no load balancing, automatic fallback or per-call override.
`search` is an ordinary routing label: it neither installs search tools nor requires
citations or a particular output format. Configure the target's actual capabilities
in its host. SDK text tasks do not require tools; live search requires a suitable
provider/tool integration supplied by the application. Permissions stay with the
chosen adapter and host; these tags grant no permissions.

Codex cells use existing `model`, `effort`, `sandbox`, `cli_path`, `codex_home` and
`timeout_ms` options. SDK cells use the existing SDK profile schema; credentials
are read from environment variables, never stored as inline API keys.

Try the complete [model-routing example](../examples/model-routing/README.md).

## Embedding in an application

`@openhilo/studio-contracts/ai-config` validates built-in direct configurations.
`configureAiRouting(routes, factory)` from `@openhilo/ai-contracts/routing` creates
an immutable router. The host factory creates each target and supplies its
non-secret configuration description as `identity`; the router generates its own
identity. Application users only edit the direct configuration above.

Pass `router.id` as `aiRoutingIdentity` to `startRun`/`resumeRun`, and forward
`context.aiRoutingIdentity` to `createDispatcher`. The runtime records and compares
this value before consuming Human input. The example shows this wiring. Custom
executors can use the same factory contract without adding a registry.

The router forwards events, questions, cancellation and results to the selected
executor. Session references retain their target and cannot move to another route.
No new retry policy or SDK conversation persistence is added. A target's failure
is returned unchanged; another target is never tried automatically.

An existing single-executor host continues working for untagged functions. Tagged
functions require a routing-capable host and fail explicitly otherwise. Legacy
`profile`/ITT `model` selectors cannot override a routed configuration.

Configuration identity detects changes in the declared execution configuration,
not provider model weights, secrets, external CLI settings or filesystem contents.
Restoring a workflow is not restoring the external model's environment.

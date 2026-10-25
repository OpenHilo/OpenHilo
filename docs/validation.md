# Testing and compatibility

Use this guide to check a source checkout or the package archives you embed.
The [language reference](../packages/compiler/LANGUAGE.md) defines supported
syntax; [compatibility](compatibility.md) defines data and recovery behavior.

## Tested environments

| Environment | Node | Coverage |
| --- | --- | --- |
| macOS arm64 | 22.23.3, 24.21.0 | Builds, types, full offline suite, package consumers and source examples |
| Ubuntu 24.04 ARM64 | 22.23.3, 24.21.0 | Fresh installation, builds, types, full offline suite and offline walkthroughs; package consumers on Node 24 |
| Ubuntu 24.04 x64 | 22.23.3, 24.21.0 | [GitHub Actions](https://github.com/OpenHilo/OpenHilo/actions/runs/39144308133): builds, types, full offline suite and package consumers on both versions |

The current [CI workflow](https://github.com/OpenHilo/OpenHilo/actions/workflows/ci.yml)
runs on Linux x64 with Node 22 and 24 for each push and pull request. Check the
run for your exact commit. Native Windows has not been verified. The local Code
adapter and report examples require Bash/Python in addition to Node; pure
compiler, contract and runtime APIs do not require those executables.

## Run the checks

From the repository root, with Node 22 or 24, npm, Bash and Python 3:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
npm run test:types
npm test
npm run check:boundaries
npm run check:packages -- --pack
npm run check:notices
npm run check:consumers
```

| Check | What it verifies |
| --- | --- |
| `test:types` | AI contract source and typed contract test consumers; all workspace sources are also checked by the build, and archive consumers by `check:consumers` |
| `npm test` | Compiler/runtime behavior, adapters, recovery, data ownership, failure paths and examples |
| `check:boundaries` | Package dependency and export boundaries |
| `check:packages -- --pack` | Contents and required assets of all twelve package archives |
| `check:notices` | Dependency licenses and generated notice files |
| `check:consumers` | Routing, Compiler, Runtime+Human, Runtime+Code, Codex, SDK and Codex UI in seven isolated installations |

Tests use temporary data and scripted providers. A guard blocks live model and
credential commands. Installation needs registry access or a populated npm cache;
the workflow tests themselves use offline fixtures. Consumer checks install
public dependencies, remove the package staging source, then verify execution
and public types from installed archives.

To retain consumer results, choose a new absolute directory outside the checkout:

```sh
npm run check:consumers -- --output /tmp/openhilo-consumer-validation
```

The resulting `report.json` records the source commit when available, archive
hashes, environment and scenario results. An unpacked source archive without Git
metadata reports a null commit. These commands build and test locally; they do
not publish npm packages.

## Language and recovery coverage

`npm run test:semantics` runs native-JavaScript comparisons and memory/recovery
regressions. The [upstream-derived corpus](../tests/upstream/README.md) documents
the selected Test262, V8 and QuickJS cases, original hashes, adaptations and
expected rejection cases. It is a subset, not full ECMAScript certification.

Coverage includes scopes and shadowing, branches and loops, evaluation order,
object sharing, nested workflow calls, continuous execution and fresh-process
Human recovery. Rejected syntax must produce diagnostics; unsupported dynamic
values must fail explicitly. Memory tests check released scopes and resources in
isolated processes; forced GC is test-only.

## Examples and real providers

Start with [compose tasks](../examples/compose-tasks/README.md) for Human requirements,
AI text processing and Code output. Follow the [local report](../examples/local-report/README.md) to check saving,
declining to save and EOF. The [review example](../examples/review-report/README.md)
also offers a scripted offline mode for exit, revision and recovery in another
process. Completed steps must not replay after a Human checkpoint.

Real Codex CLI 0.160.0 was tested on macOS arm64 with Node 24.21.0 for text
Human-directed text processing, draft/review/resume, file and reference-directory reading, document creation and revision across Human pauses, and
Code-test → AI-file-repair → Code-retest. This is a tested version, not a version
allowlist. Live-model results can vary; time and attempt limits are not token or
cost caps. Run these examples with your own authorized account and inspect the
files and recorded results.

The OpenAI/Anthropic SDK examples are experimental. Both official SDK protocols
are covered by local fixtures; live paid API acceptance remains unverified.
Passing fixtures does not establish model quality or live provider availability.

## Dependency maintenance

The resource-control and dependency update was verified locally on macOS arm64,
Node 24.22.1: 914 Node tests plus 104 Jest tests, all seven archive consumers,
the coverage instrumentation path, fresh lockfile installation, types, package
boundaries, twelve archives and fourteen notice artifacts. The environment
matrix above records earlier baseline runs; this update did not repeat those
other platforms or live paid-provider acceptance.

The 2026-10-23 resource-control update uses TypeScript 6.0.3, Jest 30.5.2,
ts-jest 29.4.15, OpenAI SDK 7.43.0, Anthropic SDK 1.2.0 and Ajv 8.20.0 with
ajv-formats 3.0.1. Node type declarations follow the supported Node 24 line
(24.19.2); isolated UI consumers use React 19.3.1 and its 19.3.0 declarations.
The compiler embeds TypeScript's JavaScript AST/compiler API. TypeScript 7.0
does not provide that API, so the compiler and build stay on the compatible
6.x line, as explained in the [TypeScript release notes](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
CommonJS builds and consumers now use Node16 module resolution; standalone ESM
artifacts use Bundler resolution, preserving the existing distribution formats.
TypeScript 6 consumers explicitly select Node types (`types: ["node"]`), plus
React types for UI consumers; ambient types are no longer implicitly included.

Jest upgrades remove `inflight` and the old glob 7 chain. One scoped root
override selects `test-exclude` 8.0.0 only under `babel-plugin-istanbul`, replacing
its glob 10 dependency with glob 13. The published v7/v8 `index.js` implementations
are identical, and this project's coverage run exercises the integration. This
override affects development tooling, not consumers of OpenHilo packages. Remove
it when the upstream dependency range includes v8. To verify that path, run:

```sh
node --require ./scripts/offline-guard.cjs node_modules/jest/bin/jest.js \
  --config packages/ai-contracts/jest.config.cjs --runInBand \
  --coverage --coverageProvider babel
npm ls --all
npm audit
```

The Anthropic 1.x SDK sends API keys using Bearer authentication. Offline tests
verify that only explicitly configured credentials/endpoints are used; ambient
authentication and endpoint values remain ignored. Standard JSON Schema formats
are preserved explicitly with ajv-formats and covered by rejection tests.

## Recovery, execution budgets and Code cleanup integration (2026-10-25)

The integration review covered both the active-time/recovery changes and the
Code cleanup/tuple fixes. The merged Code implementations retain process-group
ownership during result reads while preserving bounded failed-output diagnostics.
Host cancellation remains an abort; repairable failures require an explicit retry
of the current failed invocation. Optional tuple positions and large rest tails
are checked without recursive growth proportional to the input length.

On macOS arm64, Node 22.23.3 and 24.21.0 each passed 940 Node tests and 105 Jest
tests, with no skipped tests. Node 24 also passed the build, type checks, package
boundaries, all twelve package archives, fourteen notice artifacts and all seven
isolated archive consumers. Consumer installation required registry access;
the execution tests used offline providers and temporary run data.

Focused regressions verify that AI/Code failures inside nested loops resume
without repeating completed file effects or earlier Human answers, stale retry
tokens are rejected, invalid outputs remain diagnostics rather than successful
values, and user-answer waits do not consume the AI execution budget. Bash and
Python tests also hold a result read open during cancellation and verify that
the runtime lock remains held until the read and process cleanup settle.
Foreground SIGINT forwarding and late result growth with background descendants
are covered. This integration did not repeat live-provider acceptance or modify
existing workflow runs. Linux Node 22/24 validation runs in CI for the pushed commit.

## Limits of these checks

Passing tests does not establish full JavaScript compatibility, arbitrary crash
recovery, exactly-once external effects, untrusted-code isolation or correctness
of third-party executors. See [security](../SECURITY.md) and
[recovery limits](execution-model.md#recovery-limits).
License checks are not a dependency vulnerability audit. Long-running production
load and native Windows behavior remain outside the recorded validation.

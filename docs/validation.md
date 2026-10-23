# Testing and compatibility

Use this guide to check a source checkout or the package archives you embed.
The [language reference](../packages/compiler/LANGUAGE.md) defines supported
syntax; [compatibility](compatibility.md) defines data and recovery behavior.

## Tested environments

| Environment | Node | Coverage |
| --- | --- | --- |
| macOS arm64 | 22.23.3, 24.21.0 | Builds, types, full offline suite, package consumers and source examples |
| Ubuntu 24.04 ARM64 | 22.23.3, 24.21.0 | Fresh installation, builds, types, full offline suite and offline walkthroughs; package consumers on Node 24 |
| Ubuntu 24.04 x64 | 22.23.3, 24.21.0 | [GitHub Actions](https://github.com/eric2610abc/OpenHilo/actions/runs/39144308133): builds, types, full offline suite and package consumers on both versions |

The current [CI workflow](https://github.com/eric2610abc/OpenHilo/actions/workflows/ci.yml)
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

## Limits of these checks

Passing tests does not establish full JavaScript compatibility, arbitrary crash
recovery, exactly-once external effects, untrusted-code isolation or correctness
of third-party executors. See [security](../SECURITY.md) and
[recovery limits](execution-model.md#recovery-limits).
License checks are not a dependency vulnerability audit. Long-running production
load and native Windows behavior remain outside the recorded validation.

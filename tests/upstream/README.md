# Upstream-derived workflow semantics corpus

This is a bounded, adapted regression corpus, **not Test262 certification**, a full
JavaScript engine suite, or a claim that OpenHilo executes arbitrary JavaScript.
No upstream repository or native engine is downloaded/built during tests.

## Run

From the OpenHilo repository with installed development dependencies:

```sh
npm run test:semantics
# Optional machine-readable coverage evidence, after building:
HILO_UPSTREAM_REPORT=/tmp/openhilo-semantics.json node --test tests/integration/upstream-semantics.test.cjs
```

`npm test` includes this corpus automatically. It is offline, uses temporary run
directories, and invokes no AI provider, Studio service, or personal credentials.
The test uses the current Node executable for every recovery child, so running
under Node 22/24 exercises that same version throughout. No QuickJS binary is used.

## Provenance and licensing

`manifest.json` records upstream revisions, original paths and SHA-256 hashes,
selected sections, every adaptation, expected observations, and explicit reasons
for rejection/differences. Original source files and license texts are preserved
unchanged below; support harness/license hashes are also checked by the test.
These third-party files and derived cases retain their upstream licenses, not the
repository's blanket MIT license. See each source file's copyright notice and:

- [test262](https://github.com/tc39/test262/tree/d53ebc8b1931d9f1541e43d59650776e4b766248) — revision
  `d53ebc8b1931d9f1541e43d59650776e4b766248`; [license](test262/LICENSE).
- [v8](https://github.com/v8/v8/tree/e40edba53922265379aaebe0a17da25f963d2010) — revision
  `e40edba53922265379aaebe0a17da25f963d2010`; [license](v8/LICENSE).
- [quickjs](https://github.com/bellard/quickjs/tree/84e723f1ace5e3823cef8149dd0f890fe74b77ce) — revision
  `84e723f1ace5e3823cef8149dd0f890fe74b77ce`; [license](quickjs/LICENSE).

Fixtures are test-only, outside the twelve packages' archive allowlists. Adapted
bodies live in the manifest next to provenance rather than silently overwriting
original sources. Refreshing an upstream revision requires reviewing original
bytes, adaptation notes, expected values and licenses; never auto-update expected
values from OpenHilo output.

## What runs

1. **Native reference only**: selected original Test262/V8 files execute with their
   original assertion helpers in Node's VM. Parse-negative Test262 originals must
   throw SyntaxError. QuickJS `test_loop.js` runs unchanged; `test_language.js`
   runs only unchanged `assert`, `test_op1`, and `test_optional_chaining` functions.
   Its unrelated `test_global_var_opt` has different global-eval/property behavior
   in Node's VM, so whole-file compatibility is not claimed. This is not the
   official Test262 strict/sloppy/feature-flag runner and is not an OpenHilo pass.
2. **Native adapted reference**: each executable adapted body runs independently
   in Node/V8 and must match a literal expected result derived from the upstream
   assertion or a documented derived boundary case.
3. **Actual workflow chain**: `compileProgram` produces ITT and real run-service
   executes a parent -> child workflow in three modes: uninterrupted, Human
   answered inline, and Human checkpoint -> a fresh Node process for **every**
   resume. Outputs must match in all three modes. Loop cases pause on multiple
   iterations; the checkpoint must contain the nested call stack. A completed Code
   sentinel before the child runs once; any attempt to replay it after recovery
   fails. Its executor is a deterministic fixture; no shell/AI execution is needed
   to isolate compiler/runtime semantics.
4. Compile-negative cases must yield diagnostics and zero artifacts. Visible invalid persistent literals fail
   compilation; dynamic non-JSON or
   invalid destructuring values must fail at runtime without successful output.
   These are verified boundaries, not successful ECMAScript executions; they
   cannot meaningfully continue through a checkpoint after being rejected.

## Coverage and exclusions

There are 50 adapted/derived cases: 27 equivalent execution cases, 21 compile-time
rejections and 2 runtime rejections. There are no intentional differences in this
selected subset. They reference
Test262 (36 cases), V8 (6), and QuickJS (8); these counts are **not counts of
unchanged official tests passed**. Executable cases cover shadowing, continue and
break, scalar/flat-array foreach bindings, counted loops with existing bindings
and multiple steps, while, falsy branches, short-circuit logical assignments,
arithmetic, object identity, and array changes across pauses. Derived variants
extend selected upstream cases to our persistence and rejection boundaries.

Object identity and foreach array growth/shrink cases must match the independent
native result. One state graph preserves aliases and live loop targets across
checkpoints. The reference-state suite also checks ownership, multi-frame aliases
and unsupported-state rejections; passing these subsets is not full ECMAScript conformance.

Not covered: full JS/TS conformance; engine JIT/GC internals, d8 intrinsics, Wasm,
module-loader conformance, the complete built-in library, async generators,
closure persistence, arbitrary crash recovery, or external-effect exactly-once
execution. No native V8/QuickJS builds or Linux/Windows runs are implied. Existing
`workflow-semantics.test.cjs` retains bounded memory/WeakRef lifecycle and recovery
regressions; engine tests alone cannot prove absence of host reference leaks.

## Case inventory

Each row's source section, exact adapted body, expectation, and reason are in
[manifest.json](manifest.json). `equivalent` means this adaptation is expected to
agree with native JavaScript; `reject` means rejection during compilation;
`runtime-reject` means rejection of invalid dynamic values during execution.

| Case                                 | Source  | Classification |
|--------------------------------------|---------|----------------|
| `continue-shadow`                    | test262 | equivalent     |
| `falsy-branches`                     | test262 | equivalent     |
| `for-of-single-binding`              | test262 | equivalent     |
| `for-of-json-array`                  | test262 | equivalent     |
| `for-of-array-expand`                | test262 | equivalent     |
| `for-of-array-contract`              | test262 | equivalent     |
| `block-var-hoisting`                 | test262 | reject         |
| `let-tdz`                            | test262 | reject         |
| `const-tdz`                          | test262 | reject         |
| `for-head-destructuring`             | test262 | equivalent     |
| `for-head-redeclaration`             | test262 | reject         |
| `logical-or`                         | test262 | equivalent     |
| `logical-or-short-circuit`           | test262 | equivalent     |
| `logical-and`                        | test262 | equivalent     |
| `logical-and-short-circuit`          | test262 | equivalent     |
| `logical-nullish`                    | test262 | equivalent     |
| `logical-nullish-short-circuit`      | test262 | equivalent     |
| `v8-for-shadow`                      | v8      | equivalent     |
| `v8-for-multi-step`                  | v8      | equivalent     |
| `v8-continue-scope`                  | v8      | equivalent     |
| `v8-const-assign`                    | v8      | reject         |
| `v8-const-increment`                 | v8      | reject         |
| `v8-const-decrement`                 | v8      | reject         |
| `quickjs-while`                      | quickjs | equivalent     |
| `quickjs-while-break`                | quickjs | equivalent     |
| `quickjs-for-existing-binding`       | quickjs | equivalent     |
| `quickjs-do-while`                   | quickjs | reject         |
| `quickjs-for-in`                     | quickjs | reject         |
| `quickjs-labelled-break`             | quickjs | reject         |
| `quickjs-arithmetic`                 | quickjs | equivalent     |
| `quickjs-optional-delete`            | quickjs | reject         |
| `uninitialized-let`                  | test262 | reject         |
| `foreach-existing-target`            | test262 | reject         |
| `sparse-array`                       | test262 | reject         |
| `undefined-value`                    | test262 | reject         |
| `nan-value`                          | test262 | reject         |
| `for-of-pair-binding`                | test262 | equivalent     |
| `for-of-default-binding`             | test262 | equivalent     |
| `for-of-rest-binding`                | test262 | equivalent     |
| `for-of-object-binding`              | test262 | equivalent     |
| `for-of-hole-binding`                | test262 | equivalent     |
| `for-await-binding`                  | test262 | reject         |
| `for-uninitialized-binding`          | test262 | reject         |
| `for-of-shadow-break`                | test262 | equivalent     |
| `for-of-noniterable-element`         | test262 | runtime-reject |
| `for-of-missing-element`             | test262 | runtime-reject |
| `object-assignment-identity`         | test262 | equivalent     |
| `for-of-let-illegal-initializer`     | test262 | reject         |
| `for-of-const-illegal-initializer`   | test262 | reject         |
| `for-of-pattern-illegal-initializer` | test262 | reject         |

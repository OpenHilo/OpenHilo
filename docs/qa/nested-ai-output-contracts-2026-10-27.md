# Nested AI output contract verification

Verified on macOS arm64 with Node 24 on 2026-10-27.

## Behavior

AI return declarations now retain nested type information in optional `outputShapes` metadata. The compiler, dispatcher, Codex and SDK adapters carry it through execution. Adapters and the runtime validate completed outputs before downstream steps execute. Errors include a field path, such as `plan.urls` or `plan.items[0].score`.

Validation covers required and optional object fields, array elements, literals, unions, nullable values, tuples and records. It does not insert defaults, coerce types or guess field aliases. Extra object fields remain allowed under structural typing. Existing saved workflows without shape metadata retain their previous behavior; recompile typed source to add nested checks. Unstructured `unknown` / `any` output declarations remain unstructured.

Invalid outputs are not recorded as successful results. They are marked unsafe for automatic replay because an AI attempt may already have performed side effects. Valid Human checkpoint recovery continues to reuse completed steps.

## Verification results

- Full offline suite: 968 Node tests and 105 Jest tests passed.
- Workspace type checks, package boundaries and package-content checks passed.
- Seven independent archive consumers passed, including compiler, runtime with Human/Code, routing, Codex, SDK and Codex UI.
- Regression tests exercise both compilation paths, invalid nested metadata, missing fields, element type errors, nullable/optional values and the runtime boundary for third-party executors.
- Recovery regression verifies that a valid AI step and the preceding Code step execute once across a Human pause; invalid AI output prevents downstream execution and automatic replay.
- A separate live Codex smoke test returned a nested object containing an object array, paused for Human input, then completed a Code step. The AI was called once and before/after Code side effects each occurred once. This is live-provider acceptance evidence, not a deterministic model-quality guarantee.

Reproduce deterministic checks with `npm run test:offline`, `npm run test:types`, `npm run check:boundaries`, `npm run check:packages` and `npm run check:consumers`. The targeted regression is `tests/integration/ai-output-shape.test.cjs`; Codex and SDK adapter suites also cover invalid nested results. Live acceptance is separate from offline tests and requires an authorized provider account.

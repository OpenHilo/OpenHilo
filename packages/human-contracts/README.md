# @openhilo/human-contracts

Transport-neutral contracts for human tasks. Runtime creates a versioned `HumanTaskRequest` with stable task/run/node
identities, the prompt and inputs, an output type schema, and creation time. A `HumanExecutor` presents it with a
`HumanTaskHost`; returning from `present` does not imply a submitted result.

`HumanSubmission` carries the task ID, a caller-generated idempotency key (`submissionId`), string output values, and no
decision field. `validateHumanSubmission(request, unknown)` validates the complete submission and returns a copy without
mutating task state. It throws the shared `HumanOutputError` on invalid input.

- IDs contain 1–200 ASCII letters, digits, underscores, or hyphens and cannot be filesystem paths.
- Submissions require exactly the declared output fields. Values use the shared ITT human-output parser: complete finite
  numbers, exact `true`/`false` booleans, valid JSON, and unchanged text/file/directory strings.
- A task with no declared outputs still requires an explicit submission of `{}`. No submission means waiting.
- Approval, refusal and revision requests are ordinary business outputs defined by the workflow; there is no protocol
  rejection operation. Obsolete `decision` payloads are invalid.
- Unknown or missing submission properties and a mismatched task ID are invalid.

The host returns `accepted`, `duplicate`, `conflict`, `stale`, or `invalid` receipts. Runtime owns persistence,
idempotency, lifecycle, and scheduling. This package has no Runtime, UI, HTTP, or terminal dependency.

```ts
import { validateHumanSubmission, type HumanExecutor } from '@openhilo/human-contracts';

const executor: HumanExecutor = {
  id: 'example',
  async present(task, host) {
    // Obtain explicit business results as string values through your transport.
    // Then validateHumanSubmission(task, submission) before host.submit(submission).
  },
};
```

Build with `npm run build --workspace @openhilo/human-contracts`; run its tests with
`npm test --workspace @openhilo/human-contracts` after building dependencies.

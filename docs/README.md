# Documentation

Start with the [Quickstart](quickstart.md) to run a workflow locally without an AI
account. Then choose an example or integration guide below.

## Run and write workflows

| Goal | Guide |
| --- | --- |
| Combine Human requirements, AI processing and Code output | [Compose tasks](../examples/compose-tasks/README.md) |
| Turn local data into a report with Human review | [Local report](../examples/local-report/README.md) |
| Draft, review and revise text; pause and resume | [Review report](../examples/review-report/README.md) |
| Pass files and directories to AI, then inspect and review its output | [Document review](../examples/document-review/README.md) |
| Test a script, have AI repair it, and test again | [Script repair](../examples/script-repair/README.md) |
| Call an AI SDK directly for text | [SDK text](../examples/sdk-text/README.md) |
| Give an SDK task an explicit business tool | [SDK tools](../examples/sdk-tools/README.md) |
| Check accepted syntax and rejected forms | [Workflow language](../packages/compiler/LANGUAGE.md) · [简体中文](../packages/compiler/LANGUAGE.zh-CN.md) |
| Name Human, AI and Code tasks clearly | [Executor naming](executor-naming.md) |

## Integrate and operate

- [Embedding](embedding.md): compile source, assemble executors, submit Human results and resume runs.
- [Modules](../README.md#packages): choose the packages your application needs.
- [Execution model](execution-model.md): events, checkpoints, resource lifecycle and external effects.
- [JavaScript and recovery compatibility](compatibility.md): data types, references and process boundaries.
- [Package and session compatibility](naming-compatibility.md): identifiers and continuation requirements.
- [Troubleshooting](troubleshooting.md): installation errors, input errors and failed or suspended runs.
- [Security](../SECURITY.md): trusted code, host permissions and sensitive run data.
- [Validation](validation.md): test coverage, platform results and reproducible checks.
- [Contributing](../CONTRIBUTING.md): development setup and contribution checks.

# Security boundaries

OpenHilo runs trusted workflows with explicitly supplied executors. It does not
provide an OS sandbox or multi-tenant authorization.
Only execute source and extension handlers you trust. Code runs with host
permissions. AI workspace access and tools are explicit grants; a CLI sandbox
does not constrain a separate host tool or Code executor. A tool's read-only flag
is a declaration by its implementation, not an OS-enforced policy.

Do not include secrets in workflow files, snapshots, logs, examples or issues.
API credentials stay in the selected client's configuration/environment; Codex
credentials stay in its own installation. Review generated code before execution.
A stopped or failed attempt may already have performed an external write.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/eric2610abc/OpenHilo/security/advisories/new)
to contact the maintainers. Sign in to GitHub to submit the report. The report is
shared privately with repository maintainers, not posted as a public issue.

Include the affected commit or version, a minimal reproduction, expected and
actual behavior, and the potential impact. Remove credentials, personal data and
sensitive workflow inputs or outputs before attaching files. Do not post suspected
vulnerabilities or secrets in public issues. Ordinary bugs without security-sensitive
details can be reported through [Issues](https://github.com/eric2610abc/OpenHilo/issues).

# Contributing

Report reproducible bugs through [GitHub Issues](https://github.com/eric2610abc/OpenHilo/issues).
For vulnerabilities or sensitive run data, follow [SECURITY.md](SECURITY.md).

Use Node 22 or 24, npm, Bash and Python 3. Work on a branch and install from the
single root lockfile:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:packages
npm test
npm run test:types
npm run check:boundaries
npm run check:packages -- --pack
npm run check:notices
npm run check:consumers
```

Add a regression that fails for an actual defect before changing behavior. Prefer
journeys and failure boundaries to tests that repeat implementation details.
Ordinary tests must use local provider fixtures and temporary data. They must not
read personal credentials, invoke a real model or depend on Platform/Studio.
Live model checks are opt-in: use your own authorized account and record the
provider, model/CLI version and scenario tested.

For language/runtime changes, run `npm run test:semantics`. The
[upstream corpus](tests/upstream/README.md) preserves revisions, source hashes,
licenses and adaptation notes. Record unsupported cases and intentional JSON
value differences separately from equivalent execution; never loosen upstream
expectations to accommodate a compiler defect. Refresh external sources only as
an explicit maintenance operation, not during normal tests.

Do not reformat, optimize imports or rearrange the vendored `tests/upstream/test262/`,
`tests/upstream/v8/` or `tests/upstream/quickjs/` trees. `.prettierignore` excludes
them from Prettier; `.editorconfig` disables the JetBrains formatter and whitespace
cleanup for those paths (EditorConfig support must be enabled). Other formatters
must exclude the same trees. Do not update manifest hashes to accept formatting
changes; restore the original bytes instead. For JetBrains import optimization
and code arrangement, also add `tests/upstream/**` to Editor > Code Style >
Formatter > Do not format if your IDE does not apply EditorConfig to those actions.

Test faults must use explicit fixture configuration or syntax-based selection,
not exact source-string replacements. Assert the observed protocol response or
fault effect so a missed injection cannot pass as successful coverage.

Keep package dependencies explicit. Compiler/Runtime must not silently acquire an
AI provider, filesystem catalogue or business policy. Use public contract types
and package exports; do not reach into another package's `src` or create aliases
to private source. Maintain typed output, Human round identity and replay-safety
semantics when changing lifecycle code.

After an intentional dependency change, review the single lock and licenses, run
`npm run notices:update`, then `npm run check:notices`. The generator does not
fetch license text; missing text requires a reviewed version-bound source.
Include only dependencies used by these packages.

Packages are marked `private: true` and CI does not publish or deploy them.
For local installation, use the archive commands in the [Quickstart](docs/quickstart.md).

## Source and package releases

Develop, test and commit in this repository. Generate release archives from a
verified commit. Publishing an npm package is a separate action, never a build step.

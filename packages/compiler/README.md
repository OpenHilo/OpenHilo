# @openhilo/compiler

Pure TypeScript-syntax workflow compilation into ITT v2. Runtime dependencies are TypeScript and
`@openhilo/itt-contracts`. Importing this package does not load an AI implementation, a domain application, SQLite,
Git/worktrees, Studio or personal configuration.

```ts
import { compileProgram } from '@openhilo/compiler';

const result = compileProgram({
  files: {
    'main.ts': `
      export async function main(limit: number): Promise<{ total: number }> {
        let total: number = 0;
        for (let i: number = 0; i < limit; i++) total += i;
        return { total };
      }
    `,
  },
  entries: [{ file: 'main.ts', exportName: 'main' }],
});

if (!result.ok) console.error(result.diagnostics);
else console.log(result.artifacts, result.entries, result.dependencies);
```

The API consumes a closed set of virtual sources. Named relative imports resolve only within that set, by exported
symbol, including aliases and multiple exports from one module. Nothing is read from disk. Missing/private exports,
local-name collisions, root escapes, recursive workflow calls, and top-level executable statements in module mode
produce diagnostics. Failed compilations return no executable artifacts.

Artifact IDs combine the relative module stem and function name: `math/numbers.ts` exporting `sum` becomes
`math.numbers.sum`. Path segments must be identifier-like names (hyphens allowed, dots excluded); this keeps
module-to-namespace conversion unambiguous. File names are relative POSIX `.ts` paths. Relative imports may omit `.ts`;
`index.ts` is supported. Explicit entries must be exported functions. Entry selection and export visibility are
independent of `@tags` or any application database.

Each artifact includes its source file, declaration, CFG implementation and `sourceMap`: node ID to UTF-16 source
offsets and one-based line/column. These spans identify originating statements; this is not a JavaScript source-map-v3
file. Diagnostics identify stages and include file/position where available. Every emitted CFG passes the shared ITT
graph validator.

Supply `systemMethods` explicitly for `_by_sys` capabilities. The default catalogue is empty; the compiler does not know
entities, scheduling, accounts or business levels. `_by_ai`, `_by_human` and `_by_code` signatures remain source
declarations. Compiling them does not execute their implementations.

## Executor names

Name the business action and object from the performer's perspective, then append
`_by_human`, `_by_ai` or `_by_code`: for example `provide_topic_by_human`,
`draft_report_by_ai`, `save_report_by_code`. This is an authoring guideline, not
a compiler restriction or a call-contract requirement. See [executor naming](../../docs/executor-naming.md).

## Language and compatibility

This is a workflow DSL, not full TypeScript. See [language semantics](LANGUAGE.md). Workflow bindings preserve supported
lexical semantics: const reassignment is rejected, while object properties remain mutable as in JS. Returned objects
must exactly match declared output names, and all fall-through paths must return. Loop bodies can return early. Return
expressions are evaluated before output variables are assigned.

`compileMultiIntent`, `validateTranslatorTs`, `astToITT` and their subpath exports remain available for callers
supplying their own compilation/resolution pipeline. The single-file compatibility resolver assumes one workflow per
file with a matching export name; ambiguous multi-export imports are rejected, with a hint to use `compileProgram`. Use `compileProgram`
when a module has multiple exported workflows.

Applications supply their own system catalogue, entry selection and metadata. No platform catalogue or business defaults
are installed by this package.

## Thin CLI

`openhilo-compile program.json` reads a JSON object with the same `files`, `entries` and optional `systemMethods` as the
API, and writes one `ProgramResult` JSON object to stdout. Exit status: 0 success, 1 compilation diagnostics, 2
input/usage failure. It does not install artifacts or execute workflows. `--help` prints usage.

```sh
npm run build --workspace @openhilo/compiler
node packages/compiler/dist/cli.js packages/compiler/examples/program.json
npm test --workspace @openhilo/compiler
```

The pure API does not perform full TypeScript type checking or promise complete diagnostic spans for arbitrary syntax.
Validate source and use the documented DSL. The embedding application persists all artifacts under their qualified IDs,
including module-private functions. Runtime's value boundary separately validates values at execution time; compilation
alone is not a sandbox or an execution guarantee.

## Source skill annotations

`@openhilo/compiler/source-skills` exports `extractAiFunctions(source)` and
`rewriteSkillsDefault(source, functionName, skills)`. These pure helpers find `_by_ai` declarations and first call-site
role/instruction values, then update a declaration's skill default using AST spans and escaped string literals. They do
not scan a provider directory, choose skills, call a model or write files. Other declarations and comments remain
intact.

## Ordinary updates and destructuring

The workflow subset supports `object.field = value`, `array[index] += value`, member increment/decrement and ordinary
object/array destructuring declarations and reassignment, including aliases/defaults/nesting/rest. These compile to
existing ITT v2 nodes and preserve shared data across recovery. Unsupported patterns and nonpersistable values still
fail explicitly. See [LANGUAGE.md](LANGUAGE.md) for examples and excluded forms; this is not a full TypeScript
interpreter.

Source expressions use explicit syntax/global admission and early invalid-literal/call-arity diagnostics; dynamic data
is still runtime-checked. See the [intrinsic list and recovery boundary](../../docs/compatibility.md#direct-intrinsics).
Upgrade compiler/runtime together for the generated dynamic property-key guard.

The [workflow script contract](LANGUAGE.md) is the single current syntax specification. This compiler implements a
finite glue-script subset, not general TypeScript. Accepted combinations preserve the documented semantics; unsupported forms produce
compilation diagnostics or explicit runtime value errors.

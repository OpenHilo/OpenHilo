# OpenHilo workflow language

[简体中文](LANGUAGE.zh-CN.md)

OpenHilo uses a **limited TypeScript subset as the scripting and glue language for
recoverable workflows**: pass ordinary data, choose branches, repeat steps, and
call AI, Human, Code and child workflows. It is not a full TS/Node execution
environment and does not make arbitrary programs recoverable.

**This document defines the supported syntax.** [Compatibility](../../docs/compatibility.md)
defines data and recovery boundaries. Put complex computation and environment APIs
in Code executors; execution inside Code cannot resume at arbitrary positions.

Name executors by business action, business object and performer, from the
performer's perspective: `provide_topic_by_human`, `draft_report_by_ai`,
`save_report_by_code`. The [naming guide](../../docs/executor-naming.md) is a
readability convention, not an additional restriction on valid function names.

## 1. Supported and rejected forms

| Category | Supported | Rejected at compile time (dynamic data: see section 6) |
| --- | --- | --- |
| Bindings | Explicitly initialized let/const, block scope, inner-scope shadowing | var, access before declaration or outside scope, const reassignment, duplicate declarations; workflow bindings named undefined/NaN/Infinity |
| Control flow | if/else, blocks, counted for, while, array for-of, break/continue/return, and nesting | switch, do-while, for-in, for-await, try/catch/finally, throw, labeled jumps, debugger |
| Updates | Variable/property/index assignment, compound/logical assignment, prefix/postfix increments in standalone statements or counted-for initialization/update | Assignment/increment of outer workflow bindings embedded in conditions, arguments, right-hand expressions or callbacks; optional-chain assignment |
| Ordinary expressions | Supported-data literals, arithmetic/comparison/logical/conditional operators, typeof, template strings, property/index access, optional chains, array/object spread, listed built-ins | delete, void, instanceof, this/super/globalThis, tagged templates, classes, unknown globals, prototype reflection |
| Destructuring | Declarations, reassignment of existing variables, declaration heads of array for-of; static keys, renaming, defaults, nesting, skipped elements, rest | Computed keys, member write targets, await in defaults, non-declaration for-of heads, parenthesized assignment targets |
| Calls | Direct await of known workflows/executors, named relative imports, acyclic calls across files | Recursion, dynamic function/method aliases, workflow functions as values, arbitrary Promises, concurrency, async callbacks, generators |
| Function interfaces | Named required parameters, explicitly named output objects, ordinary return expressions | Default/optional/rest/destructured/this parameters; opaque or optional output fields |
| TS annotations | Data types listed below and erasure of expression-level type syntax | Full type checking, interfaces, recursive/generic aliases, generic workflows, advanced type operations |
| Environment | External capabilities through executors | Direct require/npm/filesystem/network/process/timer access in workflow code; unlisted global APIs |

Support includes compositions of allowed constructs in allowed positions, with
consistent scope, short-circuiting, evaluation order, references and recovery.
A semantic discrepancy in a supported composition is a bug, not a reason to add
an ad hoc restriction. Successful compilation does not guarantee that dynamic
data or external operations will succeed.

## 2. Workflows and calls

`compileProgram` takes a closed set of virtual .ts files and explicit exported
entry points; it does not read source files from disk. A file may contain multiple
exported or private async workflows. `import {child as runChild} from './child'`
resolves by export identity. Top-level executable steps, missing/private imports,
paths outside the source graph, duplicate names and call cycles are rejected.
Only named exports/imports are supported; default exports, mixed default imports
and import attributes are rejected. Workflow and executor declarations must be at
module scope; nested workflow functions are unsupported. Workflows, executors,
import aliases and registered system capabilities share one call namespace.
Duplicate names and overloads are rejected rather than resolved by taking the first.

Workflow inputs must be named and required. Every normal completion path must
return a plain object with explicit own fields. Loops are conservatively treated
as possibly running zero times: a return inside a loop alone does not establish
complete return coverage. Results may come from variables, conditionals,
properties, method calls, object spread or computed fields and are evaluated once.
Statically known field errors fail compilation. Dynamic missing/extra fields,
null, arrays, primitive returns and non-persistable values fail at runtime.
Even a zero-output workflow must return an object matching its empty field contract.

```ts
let result = (await (child)(input));
result = await child(input);
({value} = await child(input));
box.result = await child(input);
rows[index] = await child(input);
return (await child(input));
```

An awaited call must be the complete initializer, standalone statement, right-hand
side of a simple assignment, or return operand. Transparent parentheses and type
wrappers do not change this rule. Nested await in arguments, arithmetic or
destructuring defaults is unsupported, as is `x += await child()`. Business
argument counts must match; spreading call arguments is unsupported. Property
receivers and indices are evaluated once before the call, and recovery writes
back to the original target. Internal child-workflow arguments and whole return
objects preserve their reference relationships.

AI role/prompt, Human prompt and Code lang/script must be static strings or
interpolation-free templates. Constraints are static string arrays; AI skills
are declaration metadata. Pass dynamic business data as subsequent business
arguments. Executors use bodyless `declare function` declarations, with their
implementations supplied by adapters; executor declarations with bodies are
rejected. `_by_code` accepts only one optional named-input object literal with
static identifier keys, not spread, computed keys, methods or extra positional
arguments. `_by_sys` can call only methods explicitly registered by the host;
the core supplies no entity-management or scheduling capabilities.

## 3. Updates, destructuring and synchronous expressions

Place variable and member updates in standalone statements or permitted loop
positions. `rows[i++] = x` is unsupported; write `rows[i] = x; i++;` instead.
Objects, keys and right-hand values follow JS evaluation order; logical assignment
short-circuits. `(obj.x = 2)` is supported; `(obj.x) = 2` is not. Writing properties
on primitive values throws in strict mode.

A destructuring right-hand side is evaluated once. Defaults apply only when the
corresponding value is undefined; rest makes a shallow copy. Persisted bindings
still cannot contain undefined: use a default or null.
`for (const {id, name = "anon", ...rest} of rows)` uses the same binding rules.
Only arrays are iterable here. The original array and cursor are preserved;
push/splice affect subsequent iteration as in JS array for-of. Scope exit,
break/continue and return release unreachable temporary roots.

Optional property access, indexing and calls can be combined:
`a?.b.c`, `a?.[key].items[0]?.name`, `rows?.slice?.(1).length`.
Short-circuit extent, receivers and evaluation order follow JS. Parentheses in
`(a?.b).c` end the chain; TS non-null assertions do not. A short-circuit result of
undefined is allowed only as an intermediate value; use a default such as
`?? null` before retaining it.

Function expressions are limited to synchronous immediately invoked functions
(IIFEs) or direct synchronous callbacks to these methods:
map/filter/reduce/reduceRight/find/findIndex/findLast/findLastIndex/some/every/flatMap/sort/toSorted/forEach/from/replace/replaceAll.
Callback-local variables use native JS semantics, subject to the expression rules.
Functions cannot be saved/returned or inspected for source text. Async/generator
callbacks and updates to outer workflow variable bindings are unsupported.
Mutations of shared plain objects remain subject to the data rules. Workflow calls
cannot appear inside synchronous callbacks.

Known direct calls accept transparent parentheses, erased TS wrappers and static
method selection, such as `(Math.max)(1,2)`, `Math["max"](1,2)`,
`rows["map"](x=>x.id)`. See [direct intrinsics](../../docs/compatibility.md#direct-intrinsics)
for the complete list of allowed global operations. Unlisted globals, aliases of
built-in namespaces/methods, dynamic built-in lookup and modification are rejected.
Plain object/array/string methods are evaluated by JS, but escaping functions,
non-persistable results and reflection remain checked; this is not support for
the full built-in library.

## 4. Type contracts and entry inputs

| TS annotation | ITT kind |
| --- | --- |
| string / string literals and unions within that kind | text |
| number / numeric literals and unions within that kind | number |
| boolean / Boolean literals and unions within that kind | boolean |
| Plain objects, arrays, Array, ReadonlyArray, tuples, Record | json |
| any, unknown, no annotation, null, mixed unions | json |
| Standalone FilePath / DirPath | file / dir |

Parentheses and readonly wrappers use the same mapping. Compiled workflow entry
inputs additionally retain a `shape` descriptor for fields, optional properties,
arrays, tuples, literal sets, unions and Record/index values. Hosts using
`typed-text-v1` validate this shape before execution and can generate field forms.
Extra object properties are retained, consistent with structural typing; declared
index signatures still constrain their values. `any`, `unknown` and missing
annotations are unstructured JSON. Old artifacts need recompilation to acquire
shape metadata. Legacy input encoding, internal calls, locals and outputs retain
the coarse contracts above; this is not full TypeScript type checking. Unknown named, advanced and
function types are explicitly rejected, including nested annotations and local
destructuring annotations. The compatibility single-file compiler accepts only FilePath/DirPath marker aliases.
Module compilation also resolves non-generic, non-recursive JSON data aliases,
including explicit relative `import type { Report } from "./types"`. Aliases may
compose supported objects, arrays and unions; they do not add runtime values or
new data types. Interfaces, external type packages and recursive/generic aliases
are rejected. Expansion is bounded and preserves original source spans. Outputs require
`Promise<{ explicit required statically named fields }>`; optional fields, index
signatures and opaque output types are unsupported. For compatibility,
Promise<void> or an omitted return annotation denotes an empty-output contract;
the actual object-return rules still apply.

`as`, type assertions, satisfies, non-null assertions and synchronous callback type
annotations are erased when expressions are emitted. They do not convert values
or validate structure at runtime. Type syntax requiring additional helper
statements is unsupported. Workflow/executor signatures cannot be generic.

## 5. Data and recovery

Persistable values are null, Booleans, strings, finite numbers other than -0,
plain mutable objects and dense arrays, including shared acyclic reference graphs.
Unsupported values are undefined, NaN/Infinity/-0, sparse arrays or arrays with
extra properties, cycles, functions/Promises, Date/Map/Set/RegExp/BigInt,
accessors/Proxy, symbol/hidden properties, custom/null prototypes,
frozen/sealed/non-extensible objects and read-only properties. Statically known
cases fail compilation; dynamic cases fail at runtime rather than losing fields
or being converted to null.

`const b = a` shares the object; spread/rest make only shallow copies. StateGraph
preserves relationships among bindings, loop cursors and return objects across
the entire call stack. Recovery does not replay completed nodes. AI/Human/Code
are isolated data boundaries; external JSON protocols do not promise object
identity across those boundaries. Ordinary workflow JSON is not converted merely
because it resembles a FileRef. Only explicit file/dir boundaries project actual
FileRefs to paths.

Recovery does not save the whole process: PIDs and memory addresses may change,
time passes while waiting, and external files/services may change. Recorded
values remain saved; later reads observe current external state. Arbitrary-crash
recovery with exactly-once external side effects is not guaranteed. See
[compatibility](../../docs/compatibility.md). These checks are not a security sandbox.

## 6. Errors and compatibility entry points

- Unsupported static syntax, declarations and calls fail compilation.
  `compileProgram` returns diagnostics and an empty artifacts array; it never
  skips invalid steps or emits a partial workflow.
- Errors explain the reason. Source diagnostics include file, line and column
  where possible; runtime errors identify the failed node, and data errors
  identify the field path where possible. Unknown syntax must not be silently
  ignored by a fallback.
- Data-dependent errors stop execution at the relevant operation/persistence
  boundary. They are not treated as success or silently corrected. External
  actions that already happened cannot be assumed to roll back.
- The older script-style `astToITT` entry point has no function output contract
  and rejects return-await and dynamically shaped returns; use `compileProgram`.
  The older one-file/one-same-named-workflow resolver cannot resolve multiple
  exports unambiguously; use `compileProgram` for those sources.
- New artifacts require matching compiler/contracts/runtime versions. Older
  artifacts without plain-data/result metadata retain their original semantics;
  existing snapshots are not rewritten. Recompile and start a new run to use new
  semantics; mixing old and new artifacts does not repair reference handling.

## 7. Validation and bug reports

`npm run test:semantics` compares native JS, continuous execution and fresh-process
recovery, covering compositions of supported syntax, explicitly rejected forms
and dynamic data boundaries. See [testing and compatibility](../../docs/validation.md).
These checks are not full JavaScript conformance certification.

For a discrepancy in supported syntax, report minimal source, inputs, Node version,
and expected versus actual results. Do not attach credentials or private run data.

## AI selection tags

AI declarations support optional `@ai.type` and `@ai.level` JSDoc tags. They select a configured execution target without changing function arguments. See [AI routing](../../docs/ai-routing.md) for values, defaults and the runnable example.

# JavaScript semantics and recovery compatibility

OpenHilo executes a documented TypeScript workflow subset. It does not serialize a complete JS process.
See [compiler language boundaries](../packages/compiler/LANGUAGE.md) for accepted syntax.

| Category                                       | Boundary                                                                                                                                                                                                                                                                                              |
|------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Required ordinary semantics                    | Supported lexical bindings, control flow, evaluation order, ordinary object/array identity, shallow sharing, internal workflow arguments/returns, foreach original array and cursor.                                                                                                                  |
| Supported persistent data                      | null, boolean, string, finite number except -0, dense ordinary arrays, ordinary mutable string-keyed data objects, including shared acyclic graphs.                                                                                                                                                   |
| Explicitly rejected state                      | undefined, nonfinite numbers, -0, cycles, sparse/extra-property arrays, functions/promises, custom instances/prototypes (including null prototypes), Map/Set/Date/RegExp/BigInt, proxies/accessors, symbols/hidden properties, frozen/sealed/nonextensible data, readonly/nonconfigurable properties. |
| Costly language/runtime features outside scope | Persistent closures, arbitrary async queues/timers, generators, recursive workflow calls, full Node/npm environment, arbitrary-instruction checkpoints. These forms are outside the supported workflow language.                                                                   |
| Natural differences                            | New process/PID and object allocation; wall time passes; external data and resources change; new randomness/AI requests are not deterministic.                                                                                                                                                        |
| Rejected environment reflection                | instanceof, this/globalThis, static constructor/prototype access and intrinsic aliases/mutation fail compilation. Computed reflection keys fail before access at runtime. Use Array.isArray. Exact error stacks and GC/finalizer timing remain unspecified.                                           |

## Ordinary data and ownership

Within a workflow, `const b = a` shares an object. `{ ...a }` is a shallow copy: nested objects remain shared.
Equal-but-separate objects must not be merged. Supported property/index updates and ordinary destructuring also retain
native evaluation order and shallow sharing. Destructuring supports defaults/rest/nesting in ordinary declarations and
reassignment, including awaited result declarations and assignments; computed pattern keys, member targets inside
patterns, nested workflow-variable updates remain excluded; declared for-of patterns use the same supported
destructuring forms. See the compiler language guide for exact forms. Internal workflow function calls stay in this same
reference domain. Checkpoint/recovery preserves these relationships, not memory addresses.

AI/Human/Code executor inputs and outputs are data interfaces, not shared heap access. Mutating an executor input or
retaining an output must not mutate workflow state later. Host observers receive detached snapshots. Native in-process
executor payload copies preserve their internal relationships without sharing ownership. Durable Human task files and
provider/tool JSON protocols remain data-only wire contracts: alias identity and compact graph encoding across those
external transports are not promised. Avoid passing a highly shared graph to a plain JSON service as if its wire size
were its in-memory size; project the business data needed by that service.

Unsupported persistent values must be rejected rather than silently converted: a frozen object must not resume as
writable, and undefined must not disappear from a record. Transient synchronous expressions may produce ordinary
results, but the workflow compiler and raw expression evaluator have separate boundaries. The raw evaluator accepts
`new Date().toISOString()`; the current workflow compiler rejects `new Date()` even when immediately converted. Use
`Date.now()` for a workflow timestamp, or delegate date formatting to a Code capability. Retaining a Date object remains
unsupported. Compilation is not a complete static proof of dynamic value eligibility.

## Time, randomness and effects

`const startedAt = Date.now()` saves a numeric observation. A pause does not cause that completed assignment to run
again. A later `Date.now()` reads current wall time, including time spent waiting for a human; wall clocks may also be
adjusted. Likewise, saved random values remain saved, but new random calls have no promised sequence continuity. Tests
should compare these invariants, not require separate executions to draw identical random values or timestamps.

A valid controlled suspension resumes the recorded node, scopes, frames and loop state. The runtime does not replay the
whole source program. This does not guarantee arbitrary-crash recovery or exactly-once external writes: an external
action may succeed before its local outcome is recorded. Use application idempotency and inspect uncertain outcomes.

Live processes, connections, open transactions, sockets, file descriptors, timers and pending promises must be recreated
by adapters. Save resource identifiers/data rather than live handles. A saved file path is not a snapshot of its
contents. Workflow source uses the run's original artifact snapshot; dependencies, credentials and external services are
separate compatibility concerns. AI session continuation is adapter-specific, not implied by workflow recovery.

## Checkpoints and lifecycle

New checkpoints use one versioned graph for the entire call stack. Old tree checkpoints remain readable as recorded; the
runtime cannot recover relationships already lost by older serialization. Unknown versions or malformed graphs fail
before execution. Older runtimes must not consume newer graph checkpoints. Do not edit a live run's artifact snapshot or
downgrade its runtime blindly.

Runtime ownership must end when values become unreachable and resources must close on completion/suspension/failure.
Actual GC timing and RSS reductions are controlled by V8. No persistent object registry or new garbage collector is part
of this design.

## Diagnostic records

A compact shared graph must not become an exponentially large tree merely for logging. When a shared diagnostic value
would exceed the existing 64 KiB inline threshold, the runtime writes the same versioned StateGraph to a `.graph.json`
file and emits its file reference. Large shared executor input debug records also contain the self-identifying
StateGraph. Read those files with `decodeStateGraph`; they are diagnostic data, not the executor's actual input.
Ordinary small diagnostic values keep their existing JSON form. Checkpoint graph encoding is independent of this
diagnostic threshold.

## Early diagnostics and runtime checks

Expressions execute in strict mode, matching TypeScript module semantics (including primitive-property write errors).
Expression AST forms and global operations are explicitly admitted; unsupported syntax fails before artifacts.
Unknown/free globals, async/generator callbacks, function-value escapes, prototype reflection and invalid call argument
counts are rejected. This is a bounded language with type erasure, not a full TS type checker or a hostile-code sandbox.

Directly saved undefined/NaN/Infinity, negative-zero literals, sparse arrays and function/regexp literals are compile
errors. Workflow bindings/parameters named undefined, NaN or Infinity are rejected because they conflict with immutable
VM globals; synchronous callback-local names retain native lexical behavior. Transient undefined can be consumed by a
default or `?? null`. Dynamically produced invalid values, cycles and holes remain runtime errors; compilation is not a
proof of dynamic value eligibility.

Static `.constructor`, `.prototype`, `.__proto__` and literal bracket equivalents are rejected. Computed keys use native
property-key coercion once, preserving receiver, order and supported optional short circuit. Reflection keys in
destructuring patterns are also rejected (except top-level declared awaited output fields constructed as own data by the
compiler); computed destructuring keys are unsupported, including callbacks. Forbidden computed keys fail before access,
including after recovery. Ordinary payload fields with those names are conservatively inaccessible through member
expressions too; prefer other business keys. Plain records/protocols may still contain such own fields: this is an
expression access restriction.

Scalar `++/--` perform native numeric coercion: string "2" becomes number 3, not string "21". Unsupported resulting
state is explicitly rejected.

Function-valued reads from members and local aliases are guarded before escape or mutation. Direct supported method
calls retain their receiver; inherited native methods are not a hidden persistent heap. Named callback self references
permit direct calls only, not function-source inspection.

Optional property access, computed access and calls can be freely combined within the supported expression subset:
`a?.b.c`, `a?.[key].items[0]?.name`, `rows?.slice?.(1).length`. Native short circuit, argument/key evaluation order,
once-only receiver evaluation and method `this` binding are preserved. A nullish `a` skips the rest of `a?.b.c`, but a
present `a` whose `b` is null still throws. `(a?.b).c` ends the chain at the parentheses and throws when `a` is null; TS
non-null assertions such as `a?.b!.c` do not end it. Only null/undefined short circuit, not false, 0 or an empty string.

This does not introduce function-valued workflow state, optional assignment, delete, class/super/private members, or new
callable/global capabilities. A method can be invoked directly; storing it or inspecting a function-valued intermediate
still fails. Dynamic reflection-key checks run only if the optional access is evaluated. Short-circuit undefined may be
consumed transiently, but saving it still fails: use `a?.b.c ?? null` or another explicit default for persisted values.
Changes to source take effect in newly compiled runs; saved run snapshots are not rewritten.

New guarded-expression artifacts require the matching runtime helpers. Upgrade compiler/runtime together; retaining the
ITT v2 version does not imply execution compatibility with older runtimes. Existing snapshots are not rewritten.

## Direct intrinsics

Only these global uses are admitted. Intrinsic aliases/namespace values, dynamic intrinsic lookup and mutation are
rejected; static quoted/template selectors and transparent parentheses/type wrappers use the same admitted operations.
Raw evaluators and Code adapters have separate interfaces.

| Global               | Admitted direct uses                                                                                                                                                                                                                                                               |
|----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Math                 | abs, acos, acosh, asin, asinh, atan, atanh, atan2, cbrt, ceil, clz32, cos, cosh, exp, expm1, floor, fround, hypot, imul, log, log1p, log2, log10, max, min, pow, random, round, sign, sin, sinh, sqrt, tan, tanh, trunc; constants E, LN2, LN10, LOG2E, LOG10E, PI, SQRT1_2, SQRT2 |
| JSON                 | parse, stringify                                                                                                                                                                                                                                                                   |
| Array                | Array(...), new Array(...), from, isArray, of                                                                                                                                                                                                                                      |
| Object               | Object(...), assign, keys, values, entries, fromEntries, is, hasOwn                                                                                                                                                                                                                |
| String               | String(...), fromCharCode, fromCodePoint                                                                                                                                                                                                                                           |
| Number               | Number(...), isFinite, isInteger, isNaN, isSafeInteger, parseFloat, parseInt; constants EPSILON, MAX_SAFE_INTEGER, MIN_SAFE_INTEGER, MAX_VALUE, MIN_VALUE, POSITIVE_INFINITY, NEGATIVE_INFINITY, NaN                                                                               |
| Boolean              | Boolean(...)                                                                                                                                                                                                                                                                       |
| Date                 | Date(...), now, parse, UTC; new Date is still rejected by the compiler                                                                                                                                                                                                             |
| RegExp               | RegExp(...) as a transient expression; persistent regex values are rejected                                                                                                                                                                                                        |
| Conversion functions | parseInt, parseFloat, isNaN, isFinite                                                                                                                                                                                                                                              |
| Transient constants  | undefined, NaN, Infinity; cannot be saved as workflow state                                                                                                                                                                                                                        |

Number/String/Boolean/parseInt/parseFloat/isNaN/isFinite may also be direct arguments in documented synchronous callback
positions. Other function values and async callbacks are unsupported. Calls can produce invalid state: new Array(3)
creates holes and Number("invalid") produces NaN, both rejected at runtime. See
the [language guide](../packages/compiler/LANGUAGE.md) for accepted forms. New intrinsic capabilities require
review/tests, not fallback to an arbitrary VM global.

## Syntax contract and artifact compatibility

The syntax boundary is [LANGUAGE.md](../packages/compiler/LANGUAGE.md). Workflows use a finite
glue-script language; arbitrary TypeScript and Node APIs belong in external Code executors.

Compiled CFGs carry expressionSemantics=plain-data: ordinary records retain their identity even if shaped like
FileRefs. Explicit file/dir input and executor-output boundaries project real FileRefs to paths while execution logs
retain metadata. Mixed/nested json contracts do not acquire file semantics. EvalEngine.eval defaults to legacy
projection for raw callers; its data option opts into ordinary data. Custom evaluators must honor that option.

Whole internal return identity uses optional resultVar/resultTo metadata and the existing StateGraph. Upgrade
compiler/contracts/runtime together. Old unmarked artifacts retain historical projection/per-field behavior; snapshots
are not migrated or repaired. Recompile and start a new run to adopt current semantics. Entry wire encoding remains
typed-text-v1 when explicitly selected.

Source validation rejects duplicate callable identities (including executor declarations and system capabilities)
before module resolution. Import/name collisions may therefore report invalid_source at the duplicate declaration rather
than invalid_import at the import. Executor declarations must use bodyless `declare function` signatures; put their implementations in adapters.
Source changes do not modify existing run snapshots.

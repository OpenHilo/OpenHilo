# @openhilo/itt-contracts

Public ITT v2 value, file-reference, CFG, leaf-interface and extension-requirement types. No runtime third-party
dependencies, application defaults or filesystem access.

`IttValidator` checks typed CFGs for missing graph references, reserved targets, invalid loop jumps, output bindings and
code-executor declarations. `isFileRef` and node-kind guards identify ITT v2 values and node kinds. The kind
guards are not full validators for untrusted JSON; callers should not treat them as a complete schema/security boundary.

The runtime and compiler share this package. `ExtensionRequirement` belongs to the ITT contract;
`@openhilo/runtime-contracts` re-exports the same definition. Import these public packages directly;
no application scheduler or application-specific type facade is included.

`@openhilo/itt-contracts/human-output` exports `parseHumanOutputValue`, `parseHumanOutputs` and `HumanOutputError`. It
provides string wire-format validation for Runtime and custom hosts, including HTTP or UI integrations. No HTTP
endpoint or UI is included. Numbers use complete
decimal/scientific syntax and must be finite; booleans accept exactly `true`/`false`; JSON must parse without non-finite
numbers, including nested values. Complete submissions reject missing and unknown fields before returning any output.
Empty text and text whitespace are preserved. File/dir human outputs are path strings; parsing does not
check files, grant filesystem access or convert them into FileRef objects.

The human-output subpath supplies CommonJS and a self-contained ESM entry. Both come from the same TypeScript source and
have no runtime dependencies or filesystem access. The root entry provides the graph/type API.

`@openhilo/itt-contracts/run-inputs` exports `RunInputEncoding`, `RunInputSchema`, `RunInputError`,
`validateRunInputWire` and `parseRunInputs` in CJS and browser ESM. Run wire values are strings. Explicit
`typed-text-v1` decodes against the input schema exactly once, rejects missing/unknown fields, non-finite numbers and
negative zero, and preserves JSON strings distinctly from objects. When an input has optional `shape` metadata,
`validateInputShape` validates nested fields, array elements, tuple lengths, literals and unions with a field path
in each error. `InputShape` and `inputShapeLabel` let hosts render the same schema. No values are coerced or removed.
This applies to typed workflow entry inputs, not to all internal calls or outputs. Without an encoding, historical CLI conversion
remains: Number for numeric fields, true/1 for booleans, literal strings for JSON/text. The runtime applies its JSON
persistence checks afterward. See [run input encoding](../../docs/embedding.md#run-input-encoding) for
examples and compatibility boundaries.

Compiled CFGs may declare `expressionSemantics: "plain-data"` to prevent structural FileRef projection during expression
evaluation. Only explicit file/dir boundaries project paths in that mode. The validator rejects other metadata values.
Unmarked legacy artifacts retain historical semantics; upgrade compiler/contracts/runtime together and recompile rather
than editing frozen run snapshots.

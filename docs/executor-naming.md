# Name the work, then the executor

Use **business action + business object + executor suffix**. Read the name from
the task performer's perspective: what should this person, model or code do, and
what result or effect should it deliver? Use the `_by_human`, `_by_ai`
and `_by_code` suffixes. Use the project's identifier style consistently; both
`review_report_by_human` and `reviewReport_by_human` express the same principle.

| Work                              | Example name                    | Why                                                         |
|-----------------------------------|---------------------------------|-------------------------------------------------------------|
| A person supplies a writing topic | `provide_topic_by_human`        | The person provides the topic; the system asks the question |
| A person chooses a delivery date  | `choose_delivery_date_by_human` | Names the decision being made                               |
| A person reviews a report         | `review_report_by_human`        | Names the review, without prescribing its outcome           |
| AI drafts a report                | `draft_report_by_ai`            | Names the deliverable, not the model invocation             |
| AI classifies an incoming message | `classify_message_by_ai`        | Names the reasoning task                                    |
| Code summarizes input items       | `summarize_items_by_code`       | Names the deterministic transformation                      |
| Code saves a report               | `save_report_by_code`           | Names the actual external effect                            |

Avoid generic interaction or transport names such as `ask_by_human`,
`confirm_by_human`, `call_model_by_ai` or `execute_by_code`. Asking a person for a
topic is not a task in which that person asks a question. Do not mechanically use
`provide` everywhere: choose verbs such as choose, review, revise, classify,
calculate or save according to the work. A real approval task can be called
`approve_expense_by_human`; approval is not mandatory for every Human task.

Align the name, instruction, inputs and named outputs. A topic task returns a
`topic`, a review may return `approved` and `feedback`, and saving a report must
actually save it. A name does not create tools, permissions or side effects.
In the source examples, [local-report](../examples/local-report/workflow.ts) uses
`summarize_items_by_code`, `review_report_by_human` and `save_report_by_code`;
[review-report](../examples/review-report/workflow.ts) uses `draft_report_by_ai`,
`review_report_by_human` and `save_report_by_code`.

## Guidance for workflow generators

The core compiler does not generate source or install a Studio prompt. A host or
external AI that generates workflows can include this instruction alongside the
[language contract](../packages/compiler/LANGUAGE.md):

> Name executor functions from the task performer's perspective: business action
> + business object + executor suffix. Describe what Human, AI or Code must do or
> deliver, not how the host asks, invokes a model or launches a process. Use
> domain-specific verbs and objects; do not force every Human step into approval
> or a `provide` verb. Match names to instructions, typed inputs, outputs and real
> effects. Preserve the existing suffixes and call signatures. These are naming
> guidelines, not new capabilities. Reuse existing callable names when required;
> do not rename unrelated published workflows, registered system operations or
> saved run artifacts merely to enforce this style.

## Compatibility

This is an authoring convention, not a compiler restriction. Short names also compile. Parameter order,
result fields, routing and the Human submission contract are unchanged: submitting
valid business outputs continues the workflow; no submission leaves it waiting.
A business `approved: false` is data for the workflow's own branch.

Renaming a source declaration also requires updating its calls and imports; it
can change generated callee/artifact identities. Apply the convention when writing
or intentionally editing source, and compile a new run. Do not rewrite a pending
run's saved source or identifiers. Recovery uses the original snapshot.

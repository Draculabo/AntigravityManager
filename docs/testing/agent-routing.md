# Agent Routing Evaluation

This manually selected procedure investigates wrong workflow selection, scope violations or a
claim that changed instructions improve routing. The [case corpus](../../scripts/agent-routing/cases.json)
contains conversation inputs and evaluator rubrics. Its contract checks validate structure, unique
IDs, existing repository-local rule sources and a final user request. They do not execute an Agent,
classify a prompt or measure routing accuracy.

Use the [skill maintenance reference](../development/agent-skills.md) for entry consistency. Use
[historical review evaluation](review-evaluation.md) for code-defect detection and harmful repair advice.
Keep those results separate from workflow selection.

## Select inputs and preserve provenance

1. Identify the observed selection mistake or the precise comparison being investigated. Select
   affected cases plus neighboring cases that must retain their behavior; retain failures in reports.
2. Record corpus revision and SHA-256, the exact effective instructions or their captured digests,
   model/version, harness/version, available tools, budget and writable scope. Include applicable
   host instructions: repository files alone do not describe the effective instruction hierarchy.
3. Copy each case's `context` and `messages` into one fresh conversation with the intended repository
   and harness context. Keep `acceptedRoutes`, `requiredActions`, `prohibitedActions` and evaluator
   conclusions outside the tested Agent's context. Each sample gets independent context. Restrict
   access to the answer corpus where a blind comparison is claimed; a prompt is not an access boundary.
4. Use a disposable checkout or fixture environment for action-enabled trials. Fixture state must
   match the case's assumptions. Never expose real credentials or grant destructive commands merely
   because a case quotes them. A decision-only trial with execution disabled measures the proposed
   route, not actual compliance with mutation or command restrictions; record that limit.

This procedure provides no model dispatcher or sandbox. The operator supplies the execution
environment and observes actions. If independent execution or effective access limits are unavailable,
record the case as `not-run` or `unavailable`. Do not create synthetic successful responses.

## Execute and adjudicate

Save each full raw response, observed tool actions, duration and token count when available. Preserve
the original conversation order, including prior explicit workflow selection, later scope changes and
quoted untrusted content. Run the input as a conversation, not a flattened keyword list.

After execution, a human adjudicator compares response and actions with the entire rubric and the
effective instruction hierarchy. A model may assist but does not establish its own correctness.
Accepted routes are examples of allowed procedure, not exact strings to match. Judge semantics:

| Verdict       | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| `pass`        | Required behavior is observed within the exercised scope and no prohibited action occurs. |
| `fail`        | A supported selection mistake, missed required action or scope violation is observed.     |
| `unavailable` | The attempted case lacks a usable response, setup, action trace or adjudication.          |
| `not-run`     | No independent execution occurred.                                                        |

Keep a compact local report outside the repository with this shape; this is a reporting convention,
not an automatically scored or validated result format:

```json
{
  "corpusRevision": "<revision>",
  "corpusSha256": "<digest>",
  "instructionDigest": "<captured-effective-instructions>",
  "model": "<exact-model-version>",
  "harness": "<name-and-version>",
  "mode": "decision-only",
  "toolsAndScope": "<available-tools-and-access-limits>",
  "budget": "<per-case-limit>",
  "adjudicator": "<human-reviewer>",
  "cases": [
    {
      "id": "<case-id>",
      "verdict": "not-run",
      "response": null,
      "actionTrace": null,
      "reason": "Independent execution has not occurred.",
      "durationMs": null,
      "tokens": null
    }
  ]
}
```

## Compare and repair

Report case-level outcomes, unavailable samples, prohibited actions, duration and known token usage.
Compare only equivalent corpus, tools, access and budgets, identifying the changed instruction variable.
Keep all runs rather than selecting the best one. Separate decision-only and action-enabled results.
No aggregate success threshold or automatic CI model gate is defined.

Repair a confirmed mistake at its narrowest owner: description, root route, scoped instructions or
an owning workflow. Add a case only when it captures a distinct failure or preserved boundary.
Re-execute the affected and neighboring cases after a semantic change. Structural tests and schema
passes remain separate evidence; a checked-in corpus is not an executed baseline.

Changes to the corpus or validator run through `pnpm run check:agent-contracts`. Model trials remain
manually selected, require no publication and never run as a dependency of that command.

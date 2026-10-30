# Agent Lessons

This file is a short-lived queue for reusable prevention gaps found while investigating recurring failures. Current behavior and permanent requirements belong in their owning documentation, skills, tests or scripts.

## When to consult

Before implementation, read the active candidates and inspect the owning module's instructions,
tests and acceptance guidance for relevant prevention actions. Follow candidate links when the
task shares their trigger or boundary. Record applicable actions with the planned acceptance in
the task record; an empty queue does not mean the owning checks have no lessons to reuse.

Verify adoption through the check or review action actually performed. Reading a rule alone does
not establish that it protected the change. No relevant lesson is a valid result; a task needs no
separate lesson file.

## When to capture

Use this process when work follows a regression, repeated CI failure, reopened issue, rollback or failed live acceptance.

At the end of each implementation task, briefly assess which assumption changed, what earlier
checks missed and what concrete prevention action is needed. If no new gap was demonstrated,
report that only when useful; no candidate or reflection document is required. Fix the specific
defect and add its owning regression check on the first occurrence; the promotion threshold
below applies only to a reusable process rule.

When a failure appears after delivery, link it to the original task, revision or artifact and
acceptance evidence where available. Reproduce or isolate the new observation and explain what
the earlier checks missed. Distinguish product defects from fixture, artifact, environment and
requirement errors before assigning a cause. Missing original evidence remains an explicit gap.

Before adding a candidate:

- Record the observable failure and its source, such as a failing test, CI run, issue or acceptance result.
- Confirm the cause from evidence. If the cause is still uncertain, keep investigating in the task record; do not state a hypothesis as a lesson.
- Check the owning documentation, skill, test and script for an existing prevention rule. If a rule exists but did not help, identify the execution or coverage gap instead of copying the rule.
- Capture only a reusable prevention gap. A one-off defect with a complete owning regression check does not need a candidate.

Count independent incidents, not repeated jobs or retries from one incident. Separate failures caused by the same underlying gap count once unless a later change or independent environment demonstrates that the prevention still failed.

## Candidate format

Use one entry per distinct gap, with a lowercase hyphenated slug and every field below:

```markdown
### Candidate: concise-hyphenated-name

- **Rule:** The reusable prevention rule to consider.
- **Evidence:** Links to the observable incident and the verified cause.
- **Cause:** The confirmed process or coverage gap.
- **Prevention:** A concrete test, script or review question that can catch recurrence.
- **Occurrences:** Number of independent incidents and links or dates identifying them.
- **Owner:** The canonical document, skill, test suite or script owner.
```

Keep evidence sanitized. Do not include credentials, private account data, authorization headers or raw private logs. An unconfirmed cause is not eligible for promotion.

Confirmed historical defects may also seed the manually selected [review evaluation](../docs/testing/review-evaluation.md)
when they add a useful causal case and repaired control. Evaluating a case is separate from promoting
a prevention rule; the occurrence threshold and canonical-owner requirements below still apply.

## Promotion

Promote a candidate after three independent incidents show the same prevention gap. A maintainer may promote a single independently verified incident earlier when it presents a material safety, security or data-integrity risk; record the reason in the owning Agent Note.

Promotion means:

1. Put the rule in its single canonical owner, such as a testing reference, skill, contract check or scenario script.
2. Add or update executable evidence when the rule can be checked mechanically. For review-only rules, phrase a concrete question in the owning review skill.
3. Run the focused check and the Agent contract check when governance files change.
4. Remove the candidate after its owner and prevention evidence are in place. If it is rejected as duplicate, unsupported or not actionable, remove it and record any decision that maintainers need in the task or Agent Note.

Do not add a scheduled learning job. Candidates are reviewed as part of the triggering task and promoted through normal code review.

## Active candidates

Recent CI portability and local/CI quality-gate findings already have prevention rules in their owning testing and quality-check records, so they are not duplicated here.

No active candidates.

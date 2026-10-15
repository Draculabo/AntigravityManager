# Agent Note: Evidence-backed agent lessons

Status: implemented

## Problem

Recurring regressions and failed verification can reveal gaps in tests, scripts or review instructions. Without a defined capture and promotion path, those findings either remain in one task or get copied into several overlapping rules without evidence that the rule is reusable.

## Decision

Use [Agent lessons](../../../lessons.md) as a manually reviewed, temporary queue for evidence-backed prevention gaps. Capture is triggered by a regression, repeated CI failure, reopened issue, rollback or failed live acceptance. Candidates require a verified cause, a concrete prevention action, an occurrence count and a canonical owner.

Promote after three independent incidents. A maintainer may promote after one independently verified incident when a material safety, security or data-integrity risk justifies earlier action, with the reason recorded in an Agent Note. Promotion moves the rule into its canonical documentation, skill, test or script and removes it from the candidate queue.

The validation and review skills route eligible work through this process. The Agent contract checker requires the register, its root instruction route and complete fields for active candidates. No scheduled learning job or external action is part of this workflow.

## Alternatives considered

- Keep lessons only in task summaries: this does not provide a consistent place to compare repeat incidents or check for an existing owner.
- Promote every failure immediately: this turns one-off causes into permanent process rules before recurrence or reuse is established.
- Automatically promote or schedule candidate reviews: this adds unattended policy changes or recurring work without improving evidence quality.

## Consequences

The queue is intentionally empty at introduction because the recent CI portability and quality-gate findings already have prevention rules in their canonical testing and quality-check records. New entries must add evidence and an actionable guard; they must not duplicate current guidance.

The process adds a small amount of documentation and review work when a recurring failure exposes a reusable gap. It relies on the triggering task to update the register and does not automatically detect incidents outside that work.

## Verification

The `npm run check:agent-contracts` aggregate could not run because `npm` is unavailable in the shell PATH. Its registered child checks passed directly: `node --test scripts/check-agent-contracts.test.mjs` (13 tests) and `node scripts/check-agent-contracts.mjs`. Prettier passed for all changed files, and `git diff --check` reported no whitespace errors.

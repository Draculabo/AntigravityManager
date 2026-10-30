# Agent Note: Evidence-backed agent lessons

Status: implemented

## Problem

Recurring regressions and failed verification can reveal gaps in tests, scripts or review instructions. Without a defined capture and promotion path, those findings either remain in one task or get copied into several overlapping rules without evidence that the rule is reusable.

## Decision

Use [Agent lessons](../../../lessons.md) as a manually reviewed, temporary queue for evidence-backed prevention gaps. Capture is triggered by a regression, repeated CI failure, reopened issue, rollback or failed live acceptance. Candidates require a verified cause, a concrete prevention action, an occurrence count and a canonical owner.

Promote after three independent incidents. A maintainer may promote after one independently verified incident when a material safety, security or data-integrity risk justifies earlier action, with the reason recorded in an Agent Note. Promotion moves the rule into its canonical documentation, skill, test or script and removes it from the candidate queue.

Every implementation task consults relevant prevention actions before editing and assesses
demonstrated gaps at completion. The validation and review skills use the existing register and
owning checks; no new candidate is required for a successful task. Concrete regression checks are
added on the first defect, independently of the threshold for generalizing a process rule.

Failures discovered after delivery return to the original acceptance evidence where available.
This event-driven feedback covers later CI failures, user reports, reopened issues and rollbacks
without a scheduled learning job or external action. The Agent contract checker requires the
register, its root instruction route and complete fields for active candidates.

Candidates also record `Since` and `Applies while`, so their owner can reassess relevance when the
underlying mechanism changes. The checker validates a real ISO calendar date and a nonempty
condition; human review decides whether the condition still holds. Remove a candidate after its
prevention is owned elsewhere or its mechanism disappears. Age alone is not a retirement reason,
and no separate lesson archive is introduced. The existing promotion threshold remains in force.

## Alternatives considered

- Keep lessons only in task summaries: this does not provide a consistent place to compare repeat incidents or check for an existing owner.
- Promote every failure immediately: this turns one-off causes into permanent process rules before recurrence or reuse is established.
- Automatically promote or schedule candidate reviews: this adds unattended policy changes or recurring work without improving evidence quality.
- Require a lesson document for every task: this rewards records without demonstrated prevention value. Keep short acceptance and reflection in the task record, and durable checks in their existing owners.

## Consequences

The queue is intentionally empty at introduction because the recent CI portability and quality-gate findings already have prevention rules in their canonical testing and quality-check records. New entries must add evidence and an actionable guard; they must not duplicate current guidance.

The process relies on task execution to consult relevant safeguards and on reported failures to
return through acceptance. It cannot discover an unreported post-delivery incident or prove that
every relevant lesson was retrieved. Inspect failed retrieval or ineffective checks before adding
more rules; remove or narrow guidance that produces noise without actionable evidence.

Use the next three authorized behavior-changing tasks as a small pilot. Keep observations in
their existing task records: acceptance defined before implementation, deviations found before
or after delivery, the resulting safeguard, and whether a relevant prior safeguard was exercised.
Review these observations for useful actions and avoidable overhead; three tasks cannot establish
a reliability rate. No relevant reuse opportunity means reuse effectiveness remains unverified.

## Verification

The 2026-10-30 task-integrated workflow passes `pnpm run check:agent-contracts`: all 28 tests
and the document validator pass under Node 24.22.0 and pnpm 10.34.6. This establishes the
checked document structure and references, not adoption or reduced rework. The real-task pilot
has not yet run.

Initial introduction evidence:

The `npm run check:agent-contracts` aggregate could not run because `npm` is unavailable in the shell PATH. Its registered child checks passed directly: `node --test scripts/check-agent-contracts.test.mjs` (13 tests) and `node scripts/check-agent-contracts.mjs`. Prettier passed for all changed files, and `git diff --check` reported no whitespace errors.

# Agent Note: Quota Ranking and Exact Presentation

Status: implemented

Quota ranking now applies every relevant upstream bucket while model rows preserve independently managed physical slots.

## Problem

The upstream quota payload can report both per-model percentages and multiple grouped windows. Ranking by model percentages alone can recommend an account whose shared 5-hour or weekly bucket is nearly exhausted. The account card also collapsed registered tiered Gemini text models into one family row, hiding quota differences between physical model IDs.

## Decision

Shared quota utilities collect every bucket whose group or bucket metadata positively matches caller-provided normalized tokens and use the minimum as a nullable lower bound. Callers own their matching and ranking policies. Account sorting keeps conservative family aggregation, while auto-switch scores enabled priority and enabled non-priority cohorts independently against only their related groups and preserves source order on ties.

Account cards use a presentation-only selector. Registered tiered Gemini text families render visible physical model IDs and exact quota values. Provider/account summaries remain conservatively aggregated. Claude, image, unknown, and other unregistered families also remain aggregated.

## Alternatives considered

- Reusing the UI account-sort function in auto-switch was rejected because UI and switching have different cohort and ordering policies.
- Selecting the first matching bucket or preferring one window was rejected because either choice can hide the actual limiting bucket.
- Treating every non-Claude group as Gemini was rejected because absence of one provider is not evidence for another.
- Expanding every known family was rejected because image IDs and non-tiered families are not proven to represent independent quota slots.

## Consequences

Auto-switch recommendations account for both model and grouped quota constraints without introducing new recency or load-balancing behavior. The detailed and compact account cards can show independently depleted Gemini tier variants, while provider summaries continue to avoid overstating family health. New tiered text families must be explicitly registered before their physical IDs are expanded.

## Verification

- Unit coverage verifies all-bucket minimum selection, nullable lower bounds, positive-evidence matching, independent auto-switch cohorts, stable ties, exact physical rows, visibility, and conservative image/Claude/unknown aggregation.
- Provider grouping tests verify summaries retain conservative family values.

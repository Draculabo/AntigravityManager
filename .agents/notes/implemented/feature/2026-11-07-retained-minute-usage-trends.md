# Agent Note: Retained minute usage trends

Status: implemented

## Problem

Traffic Monitor exposes individual requests and attempts, but users need recent
minute trends and requested/actual model attribution without downloading all list
pages or treating the final parent response as the cost of every upstream attempt.

## Decision

Add an owned audit usageTrends operation with a bounded schema and Worker query,
reusing the selected desktop or standalone audit owner and typed IPC route. Keep
existing current-cycle usageRange behavior separate. The query uses parent-start
cohorts and a captured clock for a consistent logical request count across minute
buckets; usage still comes only from selected physical generation attempts.

A single SQLite read transaction supplies totals, minute buckets and model rows.
Unknown input/output aggregates remain null. Requested and actual model attribution
use their respective saved fields without guessed fallback. Model detail limits
do not limit totals. The frontend owns a separately validated local preference for
trend filters, rather than changing the existing request-list search contract.

Current behavior is specified in the [diagnostic reference](../../../../docs/modules/proxy-gateway/diagnostic-retention.md#minute-usage-trends).

The same operation can include daily activity when the panel is expanded. The
Worker resolves local day boundaries and counts each matching parent once per day.
This shares the minute query's eligibility and attribution rules. The optional
fields preserve the minute-only contract and avoid reading 30 days by default.

## Alternatives considered

- Aggregating paginated renderer list data omits records outside loaded pages and
  transfers unnecessary per-request metadata. The Worker reads bounded cohorts.
- Adding parent totals to attempt counters double-counts final successful sends
  and can hide failed retries. Only physical attempt counters contribute.
- Mapping missing counters to zero or falling back from actual to requested model
  manufactures evidence. Null counters and model IDs retain the distinction.
- Sharing trend filters with log-list filters silently changes the table's search
  semantics. Independent local preference ownership keeps each operation explicit.

## Consequences

The new API is additive and read-only; no audit schema or account credential format
changes. Old records remain available. Disabling or removing the trends view does
not require account-state restoration. Local filters are convenience metadata and
do not contain authorization, bodies or session content.

Trends describe retained history, not complete billing or official-cycle accounting.
Requests spanning model groups can appear once in each model row, while overall
request totals remain distinct. Parent-start cohorting omits earlier-started work
from the recent cohort even if that work finishes later. Missing attempt usage can
make a Token aggregate unknown instead of presenting a lower bound as a full total.

## Verification

Implementation source and selected-owner wiring were reviewed. No tests, type check,
format/build/governance checks, native database runner or rendered UI validation
were executed because the user deferred that work. Deferred cases and actual review
outcomes are recorded in the implementation TODO (local artifact `d02-usage-trends/implementation-status.md` in the 2026-11-07 review collection).

# Agent Note: Subscription identity and refresh evidence

Status: implemented

## Problem

Project discovery preferred display names over official tier IDs and could treat a
recommended/default purchasable tier as the current subscription. A project lookup
failure followed by successful model lookup could remove a previously saved paid
tier. Stored labels alone could not distinguish confirmed identity, an unknown ID,
missing authority and a failed refresh.

## Decision

The account owner resolves paid/current identities in priority order with stable ID
precedence and exact recognized aliases. Allowed tiers corroborate only free-tier.
Nullable optional project/tier fields are normalized to absence at the upstream
boundary; they do not invalidate another usable identity on that response.
Unknown authoritative IDs use the free baseline while retaining their original value
and source; model visibility never proves subscription. The D02 rules require independent evidence before treating a default paid offer as an active subscription.

An optional subscription state is added to existing quota JSON. Strict runtime codecs
validate status, canonical tier, source, bounded raw selected value and local times.
A successful observation is separate from the latest refresh attempt. A failed or
authority-incomplete refresh keeps the last observation and tier without restamping
it. Fresh explicit FREE or unknown authoritative identity can replace prior paid
state. Recorded evidence cannot be overwritten by an older check or a timestamp-free
legacy response. These checks supplement, rather than replace, D01 account identity,
write transaction and completion-order fences.

The existing quota merge invokes the subscription owner before window reconciliation,
including when no summary windows exist. Keeping the merge at the existing account
write boundary covers manual, monitor, enrollment, warmup and gateway consumers with
the same semantics; it does not introduce a second subscription store or writer.
Quota lookup continues to discover current subscription regardless of a previously
resolved project. No extra OAuth/model attempt or background poll is introduced.

## Alternatives considered

- Name-first selection can contradict official IDs and changes under localization.
- Substring matching for pro/ultra can classify marketing text as paid authority.
- Treating allowed/default paid offers as purchase evidence grants unsupported labels.
- Falling back to visible Claude/GPT models conflates entitlement, capability and quota.
- Dropping a cached tier on transport failure fabricates an authoritative downgrade.
- Keeping old paid state after a fresh explicit free response prevents real downgrades.
- Giving retained observations a new timestamp misrepresents stale data as current.
- A second database table or required metadata would add migration and historical
  reconstruction obligations without an existing need.

## Consequences

The field is optional and additive within the existing JSON format; absence means no
recorded evidence. No SQL migration, credential move or historical backfill occurs.
Malformed supplied metadata is rejected by the quota codec. Raw ID/name evidence
is bounded at 256 characters and is not added to logs, renderer account projections
or generation protocol output. A separate allowlisted renderer projection includes
refresh status, observation status, source category and recorded check/observation
times. It excludes the raw selected value and duplicate canonical identity. The
keyboard-focusable badge explains retention, unknown/missing authority and legacy
records without inventing freshness. The canonical tier remains compatible with current
badge/filter consumers. Unknown IDs may temporarily classify a new paid plan as free;
the retained source allows a later explicit mapping update.

Older binaries can read the quota payload but may strip optional evidence on rewrite.
Returning to this version then requires an ordinary successful refresh to recreate
it; discarded historical observations cannot be reconstructed. Packaged downgrade
is not established by codec/native repository tests. Local clock rollback may retain
newer recorded evidence conservatively. Total quota failure follows the existing
operation-error path instead of writing a successful partial subscription update.
The badge can explain only recorded quota state: a total quota failure does not
persist a newer partial subscription result. Full D02 acceptance, official-cycle
accounting, authoritative group/model membership and real-provider comparisons
remain open; this decision does not complete those obligations.

## Verification

Transport-substituted public Google API checks cover precedence, recognized aliases,
unknown/missing authority, malformed values, failure retention and repeated project
discovery. Merge checks cover observation retention, downgrade, stale writes and
renderer exclusion. Temporary native SQLite checks round-trip metadata and enforce
retention/downgrade at the existing transaction boundary.
Safe projection rejection, keyboard-accessible explanations and six-language UI
checks cover the allowlisted renderer state.

The backend selected matrix passed 1,337 tests in 122 files. A subsequent nullable
upstream-field correction passed the affected 80 tests in seven files; that focused
run is not represented as another complete matrix. The final UI selection passed
1,385 tests in 129 files. Counts overlap and are not added. Negative controls exposed
ID/name disagreement, unsupported paid offers, loss of retained observations, nullable
upstream fields, unsafe renderer projection and clock rollback before their fixes.
Type checking, focused lint/formatting, runtime boundaries and Agent contracts passed
for those slices using the pinned Node 24.22.0/pnpm 10.34.6 runner.

These are historical controlled results, not checks rerun for this documentation
correction. Local reports named `D02-subscription-recovery-implementation.md` and
`D02-freshness-ui-implementation.md` under ignored `artifacts/` contain further run
detail; the retained summary above does not require those reports in a checkout.
Temporary native SQLite and DOM evidence do not establish packaged downgrade,
installed-client behavior, live-provider parity or full D02 acceptance.

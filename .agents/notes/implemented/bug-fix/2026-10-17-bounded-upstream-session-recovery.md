# Agent Note: Bounded upstream session recovery

Status: implemented

## Problem

Confirmed D03 R11 permits one additional generation send for a recognized input-token
limit HTTP 400, before downstream output and while the request and lease remain valid.
R12 requires account/store isolation, bounded state and merged concurrent recovery.
A process-wide generation map would make it difficult to bound state and isolate accounts.
An ordinary retry loop would leave concurrent recovery work unmerged.

## Decision

The existing singleton Gemini client owns an in-memory cache of at most 500
account/store-derived identity records, expiring after one hour of inactivity using
a monotonic clock. It stores digests/identities only. No timer, durable format,
history migration or global map is added. A record reference acts as the compare-
and-set token: concurrent failures of one generation reuse a single replacement,
and an evicted/expired reference cannot recreate state. Recovered identities include
a random incarnation so eviction/restart cannot repeatedly recreate an old bumped
upstream identity. Generation-zero wire identity remains unchanged.

Only the typed upstream HTTP 400 with the recognized input-token-count error may
recover. Normal execution, including existing cache-resource fallback, runs first.
After its failure, at most one actual additional content send uses the complete
prepared input, the same credential/model and a fresh request ID. It has no endpoint
or project-header fallback and spends only the remaining original client-call timeout
budget. This happens before a response stream is returned, so it cannot replay an
already-emitted stream. It neither compresses history nor executes tools.

Generated protocol services supply a lease-eligibility predicate with their
existing identity. Admission and identity advancement occur immediately at the
physical resend boundary after cancellation, deadline and lease checks. Original
and recovery failures retain their attempt diagnostics; the final error keeps the
first failure as a cause when it has no existing cause. Direct auxiliary callers
without the owning lease predicate do not gain recovery implicitly.

One mutable send/deadline budget belongs to the logical protocol invocation, across
account/project/signature/aggregation alternatives. The deadline starts on its first
Gemini client entry, including thought preparation; it does not measure earlier HTTP
parsing, model routing or account selection. Recovery errors are weakly marked by
identity without changing their status/message/stack. Protocol catch boundaries
release any image permit and propagate that error before alternate dispatch, ordinary
retry or account penalties. The final failure is reported even when it would normally
qualify for project or thought-signature repair. Unrelated first-call failures retain
their existing policy. Markers retain no strong error references or conversation data.

Permanent cloud-account deletion synchronously forgets that account's recovery records
through the existing running-gateway cleanup hook. Records retain their internal account
ID for that bounded lookup; this identifier never becomes a new upstream envelope field.
The lease predicate also gates initial metadata admission. In-flight record references are
revoked by deletion; re-adding the same account/store creates a different record reference.
The hook attempts both recovery and lease cleanup even if either fails, preserving one
original error or aggregating both. The durable deletion owner's existing partial-success
report remains authoritative. A stopped gateway does not instantiate a new client cache.

This slice does not claim the complete R12 lifecycle: targeted administrative
session/global cleanup across Thoughts/Responses remains a D16 joint obligation.
The cache retains no conversation body or persisted history and cannot restore a
deleted local record. No cross-restart generation persistence is proposed.

## Alternatives considered

- An unbounded global generation map violates the confirmed resource boundary.
- A new random identity for every normal turn loses stable upstream sessions.
- Reusing deterministic generation one after cache eviction can revisit an old
  overflowed upstream session; a random recovery incarnation avoids that reuse.
- Sending through the ordinary account retry loop can rotate accounts or multiply
  fallback sends; one dedicated physical resend preserves the selected lease.
- Recovering arbitrary HTTP 400 or errors after stream output can replay unsafe work.

## Verification

Controlled tests cover recognized and unrelated errors, one resend only,
same-account/body/model preservation, fresh request IDs, cross-tenant/account scope,
concurrent compare-and-set, expiry/eviction and stale handles, cancellation, exhausted
time budget, changed lease eligibility, stream/unary parity and failed recovery.
They verify actual Axios serialization and audit/capture behavior as supported.
Owning protocol, signature/cache, retry and lifecycle tests plus type/lint/boundary/
governance checks are selected by the project validation skill. Real profiles,
providers, installed clients and final domain acceptance remain deferred.

The protocol tests wire real protocol, retry and Gemini client services to a synthetic
Axios boundary and two synthetic accounts. They verify final 429, project and signature
errors cannot dispatch a third generation call for unary/streaming Chat, Responses,
Messages and native Gemini. Cache and budget mutation controls demonstrate that the
checks detect disabled capacity, reset logical budgets and lost failure ownership.
The completed recovery selection passed 317 tests in 22 files; its account-cleanup
follow-up passed 366 tests in 26 files. Both had zero failures and zero skips.
The latter adds deletion/re-addition, stale-frame and running/stopped-gateway checks.
These are separate, overlapping historical selections, not additive counts or a
claim that the current workspace has been revalidated.

The pinned Node 24.22.0/pnpm 10.34.6 runner invoked selected `pnpm exec vitest run`
files. Type checking, focused lint/formatting, runtime/type boundaries and Agent
contracts passed for each slice. Mutation controls detected disabled terminal-failure
ownership, reset budgets, missing capacity eviction, lost record invalidation and
omitted runtime cleanup; source restoration was verified by SHA-256.
Local reports named `D03-session-recovery-implementation.md` and
`D03-recovery-account-cleanup-implementation.md` under ignored `artifacts/` retain
additional run details. The summary here is the repository-retained evidence;
those local files are not prerequisites for understanding the validation limits.

## Consequences

An oversized single input can still fail after recovery. Cache eviction/restart may
require another bounded recovery of the generation-zero upstream identity. The one-
hour/500-record cache is not a durable conversation store or a complete D16 lifecycle
solution. A provider response lost after dispatch has uncertain remote effects;
this feature does not classify transport failures as recoverable context errors.
Failed recovery does not run ordinary account punishment, including for a final 429;
the attempt remains visible in existing audit/capture instead. Targeted session/global cleanup,
earlier request-stage deadlines and cross-restart state require separate owning work.

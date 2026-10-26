# Agent Note: Per-attempt usage attribution with separate account lifecycle evidence

Status: proposed

Scope decision (2026-10-17): deferred enhancement. The confirmed D02 priority is a
current-provider-cycle view of retained local usage, with missing/ambiguous coverage
visible. The existing compatibility scope does not require this schema extension. No migration or
per-attempt capture implementation is authorized by this proposal's existence.

## Problem

Confirmed D02 R9/R10 requires stable account attribution and non-duplicated local
cycle usage. The existing audit database records tokens on the parent request and
only account ID/model on upstream attempts. It does not record account lifecycle
generation. `TrafficAuditRepository.completeParent` chooses a preferred attempt for
display attribution, which cannot prove ownership of the parent's tokens after
rotation/retries. Reused account IDs cannot distinguish deleted/recreated accounts.

The implemented `usageRange` foundation therefore labels retained account-ID-only
coverage and excludes ambiguous parents. No choice of a query predicate can recover
missing historical per-attempt usage or generation evidence. This is an information
gap, not a transient request error or a reason to retry a model/tool. Lifecycle
generation can establish which local incarnation executed an attempt; it does not
establish the logical provider account whose quota cycle owns the usage. Removing
and re-adding the same Google account does not restart its provider quota cycle.

## Proposal

Subject to explicit schema-scope approval, extend the existing `upstream_attempts`
table with nullable account-generation and canonical input/output/cached/reasoning
token columns. Keep request/body storage, account credentials, profile locations and
retention ownership unchanged. Do not create another archive or token database.

Account generation must come from the actual selected lease context at execution,
never from a later database lookup by account ID. Pass only the ID/generation pair
through the request-local audit context. Bind usage capture to the corresponding
attempt handle; callbacks from another attempt must not replace it. Normalize
provider cumulative usage with the existing usage semantics, rather than summing
every streaming snapshot or adding cache/reasoning twice.

Known usage on failed/cancelled attempts may be retained when the owning provider
actually reports it. Missing quantities remain null. An unknown outcome is not
invented as success or zero. Reporting failure must not replay generation or tools.
The audit pipeline remains bounded and best-effort; dropped records continue to make
history incomplete. Source failures retain trusted diagnostics.

Introduce an explicit audit schema migration from current version 4 to version 5.
Before mutation, create and verify a consistent owner-local v4 snapshot using an
existing SQLite-supported backup mechanism. Migration must be a transaction that
adds nullable columns and advances the schema version only on success. Preserve all
existing rows and avoid the generic old-schema path that renames/recreates the
database. Reopening v5 is idempotent. Migration/backup failure must preserve the v4
database and report failure; do not silently replace it with an empty store.

Old rows remain unverified history: do not backfill account generation from today's
account record, distribute parent totals across attempts or manufacture per-attempt
usage from incomplete payloads. A future cycle query must use verified stable provider
account identity and exact model/group membership, report retained coverage and
distinguish unattributable/missing data. It must not restrict a provider account's
cycle subtotal to its current local lifecycle generation. Multiple verified local
incarnations of the same provider account may contribute within one cycle; a reused
local ID alone cannot prove that they belong together. Historical identity that
cannot be verified stays incomplete rather than being guessed from today's row.
The stable-identity capture/retention contract must be resolved before implementing
this enhancement. D08 authoritative group membership remains a separate dependency;
these columns cannot create it.

The migration backup belongs to this audit owner and must have a verified bounded
location and an explicit retention/removal policy. It is a one-time recovery snapshot,
not a new usage archive. The exact synchronous backup primitive, recovery name and
cleanup policy must be implemented and tested before any profile migration is enabled.

## Alternatives considered

- Keep the current partial query: safe but excludes retry/rotation parents and cannot
  certify account incarnation. This remains the current behavior without approval.
- Assign parent totals to the last/successful account: rejected because account
  attribution is not per-attempt billing evidence.
- Filter by account creation time: imported/recreated identities can reuse historical
  times; it cannot substitute for the lease's storage generation.
- Reconstruct all history from response bodies: retention/deletion/partial streams
  make this incomplete and it can misattribute another attempt's usage.
- Add a separate archive: rejected as unnecessary duplicate persistence and an
  unconfirmed retention obligation.

## Acceptance criteria

- Real temporary SQLite v4 fixtures preserve every existing row and body reference
  across upgrade, reopen and failed migration/backup cases.
- Generation capture uses the admitted lease incarnation and survives controlled
  delete/recreate races without reading a newer incarnation into an old attempt.
- Interleaved attempts on accounts A/B and simultaneous requests cannot exchange
  usage; duplicate cumulative streaming reports are not added repeatedly.
- Success, reported partial usage, cancellation, timeout, dropped audit writes and
  shutdown have observable ownership and cleanup.
- Group/model/provider-account/time boundaries are strict and malformed/unsafe
  totals are rejected. Lifecycle generation remains write-ownership evidence, not a
  quota reset. Verified re-additions of the same provider account retain cycle usage;
  reused local IDs for a different identity cannot merge it. Cache/reasoning remain
  separate evidence without double count.
- Historical unverified rows remain visibly incomplete; complete absence is not
  presented as authoritative zero.
- Older binaries refuse v5. Document recovery from the v4 snapshot, including loss
  of audit records written after that snapshot, without deleting the v5 original or
  modifying accounts/credentials. Preserve newer audit history before an explicit
  user-chosen downgrade.
- Update current references and an upgrade guide with the actual version policy;
  run focused migration/capture/owner/IPC tests, type/lint/boundary and Agent checks.
- All implementation acceptance uses isolated fixtures. Real profile migration,
  real providers, installed clients and final domain acceptance remain deferred.

## Risks

This adds durable audit fields and changes migration/recovery behavior, so it needs
the explicit task scope required by repository instructions. It does not establish
complete all-channel provider consumption. Audit history can still be disabled,
dropped, deleted or expired, and authoritative model-group mapping remains missing.
An older binary cannot read the new schema; the rollback data-loss boundary must be
clear before implementation is accepted. No schema code or real profile has been
changed by this proposal.

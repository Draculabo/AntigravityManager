# Agent Note: Warmup and legacy backfill writeback

Status: implemented

## Problem

Queued warmup retained caller-owned account objects, discovered projects without
checking current identity, and wrote whole token/quota values by account ID. An
old task could consume quota or overwrite replacement account state. Legacy OAuth
backfill could similarly overwrite new token metadata and mark migration complete
after a no-op write to a deleted account.

## Decision

Warmup and its follow-up runner snapshot account input at admission. The existing
refresh context owner checks identity, grant/client/proxy and access token before
dependent provider work and follow-up writes. Project and legacy whole-token
writes share a complete-token guard at the existing SQLite transaction boundary.
Comparison omits undefined optional properties to match JSON persistence without
changing the durable format. Ordinary access/grant refresh behavior is unchanged.

Legacy backfill retains per-account fail-soft continuation and its existing
enterprise guard, but rejects stale writes and leaves completion unset on failure.
Warmup and quota follow-up preserve original causes in diagnostic warnings.

An accepted generation can already consume quota. Save its existing account/bucket/
reset-cycle history before checking whether follow-up is still owned. If ownership
changed, report accepted generation with failed account follow-up and omit the ID
from subsequent quota work. This prevents automatic repeat cost without claiming
the replacement succeeded. Cancellation keeps its existing separate semantics.
History save failure still pauses all warmup until restart.

Current behavior belongs in
[weekly warmup](../../../../docs/modules/cloud-account/overview.md#weekly-warmup)
and [refresh ownership](../../../../docs/modules/cloud-account/overview.md#oauth-refresh-ownership).

## Alternatives considered

- Checking only credential context before a whole-token project/backfill write
  could still discard newer project/session metadata with unchanged credentials.
- Mutating caller objects would let an old queued job silently adopt new values
  instead of proving it still owns its original account context.
- Dropping history after accepted old generation would permit repeated cost for
  the same cycle. Persisting accepted effect evidence is safer than replay.
- Marking stale completion successful would schedule a quota probe for replacement
  credentials, so the accepted-effect record and follow-up eligibility are separate.
- A new schema or permanent deletion tombstone is not needed for this differing-
  context slice and would require a separate same-value lifecycle decision.

## Consequences

Accepted history can suppress warmup for a replacement with the same account ID
and reset cycle; this intentionally prioritizes duplicate-cost prevention. It is
not a record that the new credentials completed warmup. Provider work already
dispatched cannot be undone. No new retry or external request is added.

The runner persists quota without mutating caller-owned snapshots. Views retain
their normal local reread policy. Same-value delete/recreate, final-check-to-dispatch
gaps, same-context quota ordering, current eligibility changes without identity
changes, switch/import effects, late generation penalties and durable preference
cleanup remain separate obligations. Existing notes retain those active limits.

## Verification

All 13 initial controls failed before implementation. Controlled overlap covers
deleted/replaced inputs, project result races, queued caller mutation, inter-account
waits, accepted-effect history, late quota and stale legacy backfill. Native SQLite
tests use temporary synthetic profiles and the installed Electron ABI for whole-
token metadata rejection and undefined-field round trips. Loopback HTTP transport
is separate from real provider/account acceptance. See the
D01 warmup/backfill report (local artifact `D01-warmup-backfill-implementation.md` in the 2026-10-11 review collection).

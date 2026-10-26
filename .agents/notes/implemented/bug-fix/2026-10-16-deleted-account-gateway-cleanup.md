# Agent Note: Deleted-account gateway cleanup

Status: implemented

## Problem

Desktop and standalone-core deletion removed the durable row without evicting its
gateway entry. Pending quota results could write and publish an obsolete entry
after eviction. Narrow OAuth eviction also intentionally retained quota and
capability state, so it could not stand in for permanent deletion.

## Decision

A cloud-account deletion service owns the database commit followed by gateway
cleanup. Both existing entry points call it; standalone deletion joins existing
mutation admission and shutdown drain. No public request/response schema changes.
The repository keeps its atomic row/current-client-reference transaction and
does not import gateway business policy.

Permanent deletion uses a separate gateway operation that first evicts the entry
and clears its runtime state, then strictly saves retained availability records.
The stopped gateway still clears its persistent singleton availability owner.
Other accounts are preserved; OAuth quarantine keeps narrower existing semantics.

Strict availability cleanup validates a cold snapshot and propagates persistence
failures. An unsuccessful ordinary hydration cannot write a replacement snapshot.
Explicit deletion retry can retry failed hydration or saving, even after the row
is gone. There is no automatic retry, new schema or durable tombstone.

Realtime quota work checks entry identity and credential context after provider
completion and after awaited persistence. Stale work does not publish or dispatch
a new write. A distinct internal stale outcome suppresses fallback error locks.

Current behavior belongs in
[deleted-account cleanup](../../../../docs/modules/proxy-gateway/account-leases.md#deleted-account-cleanup).

## Alternatives considered

- Reusing OAuth eviction would retain deletion-owned limits and availability.
- Full cache reload would reset unrelated sessions/locks and depend on another read.
- Swallowing cleanup failures would report success while stale persistent state remains.
- Restoring the deleted row would require reconstructing credentials and undoing a
  committed operation; cleanup failure is instead explicit partial completion.
- Defaulting unreadable availability to an empty snapshot could delete other
  accounts' protection. Strict deletion refuses that write.

## Consequences

Failure before the database commit leaves runtime state intact. Failure after
commit does not restore the row; runtime eviction precedes availability saving.
The error retains its cause and states that cleanup needs an explicit retry.
Provider work already sent is not cancelled or replayed.

This slice does not establish durable same-value delete/recreate generations,
conditional completion of already dispatched repository writes, caller-owned
monitor/status writes, late generation penalties or persisted preferred-account
configuration cleanup. Those remain D01-R12 obligations. Existing D02/D08/D18
joint rules and final live acceptance remain separate.

## Verification

Five quota lifecycle negative controls failed before the fix. Owning tests use
controlled promise barriers and synthetic stores for deletion ordering, committed
partial failure/retry, stale quota outcomes, other-account isolation, strict cold
availability cleanup and both desktop/core entry points. No real credentials or
provider calls are used. Final counts and command evidence are recorded in the
D01 deletion report (local artifact `D01-deletion-cleanup-implementation.md` in the 2026-10-11 review collection).

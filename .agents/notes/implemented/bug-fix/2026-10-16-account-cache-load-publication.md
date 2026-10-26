# Agent Note: Account-cache load publication

Status: implemented

## Problem

Every completed account-store read cleared and replaced the live token map. An
older load could overwrite a newer published pool, restore an account evicted
while reading, or discard a credential/project/health update made in memory.
Strict reload would then reset sessions and limits as if that snapshot were current.

## Decision

The token-cache owner gives each load an ephemeral publication generation. New
loads and accepted eviction invalidate prior generations, including eviction from
an empty pool. The owner also captures entry identity and shallow token state
before awaiting storage, rejecting a result if that live state changed meanwhile.
This observes existing scalar updates and immutable nested replacement owners
without adding durable state or per-account tombstone retention.

The current snapshot is converted completely before replacing the live token map.
A superseded read applies neither token entries nor model-forwarding snapshots.
Ordinary loading retains its logged zero-result failure contract; strict reload
propagates a distinct superseded-load error and skips its session/limit reset.
The unused permissive reload helper is removed rather than retaining a second
reset path that could treat failed loading as successful.

Current behavior belongs in
[account-cache load publication](../../../../docs/modules/proxy-gateway/account-leases.md#account-cache-load-publication).

## Alternatives considered

- Completion-order publication would let a slower old snapshot win.
- Letting an older success publish after a newer failure would disregard the newer
  observation and could restore a deleted or blocked account.
- Serializing all loads would make a fresh request wait behind stale work and
  would still require eviction/update ownership checks.
- Retaining every evicted account ID as a permanent tombstone would grow state and
  prevent intentional new storage snapshots from restoring a reauthorized account.
- Clearing shared limits or retrying loads automatically would change unrelated
  recovery and request-budget policy.

## Consequences

Concurrent requests can receive a zero ordinary-load result or a strict reload
error while the last successfully published pool remains intact. A caller can
explicitly request a new read after contention; this change does not add retries.
In-flight reads settle normally and retain temporary shallow snapshots until then.

The generation protects this cache owner, not durable rows or arbitrary nested
in-place mutations. Eviction must reach the owner to invalidate an empty-cache
read. Wiring every desktop/core deletion entry point, clearing all account-owned
state, same-value delete/recreate histories and caller-owned persistence remain
D01-R12 obligations. Global forwarding updates keep their existing synchronous
callback semantics; no general rollback of callback side effects is introduced.

## Verification

All seven initial negative controls failed before the fix. Controlled tests cover
both load completion orders, a newer failed read, eviction from loaded/empty pools,
live credential/project/health changes, replacement entry identity, a rejected
conditional eviction, fresh loading after eviction, and strict reload preserving
unrelated quota locks. The owning cache/service tests and protocol/queue regressions
run without real accounts or providers. See the
D01 load-publication report (local artifact `D01-load-publication-implementation.md` in the 2026-10-11 review collection).

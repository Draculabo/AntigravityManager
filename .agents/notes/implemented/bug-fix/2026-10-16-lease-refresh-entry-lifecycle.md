# Agent Note: Lease refresh entry lifecycle

Status: implemented

## Problem

Lease refresh coalesced by account ID and wrote its response back into the cache
unconditionally. Deleting or replacing that account during a provider request
could resurrect the old entry. An old refresh-blocked response could instead delete
a newer entry. Refresh persistence did not carry the project path's stale-write
guard, allowing queued old credentials to overwrite a replacement.

## Decision

The hydration owner coalesces refresh work by weak cache-entry identity and a
captured refresh credential, OAuth client, email and proxy context. It checks that
context before refresh and before applying either success or destructive failure.
The old operation cannot acquire or mutate a replacement entry. Replaced contexts
start independently, while concurrent use of one live context shares its operation.

Refresh success mutates its still-current entry without reinserting by account ID.
Deferred snapshots carry a post-refresh context and token-version guard through
the persistence owner, including its final awaited account read. Hydration checks
again after project resolution; selection checks identity and eligibility before
returning. Stale work produces a distinct internal failure, with the original
upstream exception retained as cause when available. Typed invalid-grant failures
also retain their original cause.

This extends the lifecycle protection around the existing
[background persistence queue](2026-09-13-account-lease-background-token-persistence.md)
and [project-discovery contract](../../../../docs/modules/proxy-gateway/account-leases.md#project-discovery-failures).
It does not replace either owner or change database formats.

## Alternatives considered

- Deleting an ID-keyed lock during eviction would let old completion remove a new
  lock and would still allow ID-based writeback into a replacement.
- Waiting for old account-ID work would unnecessarily couple a new credential
  context to an unrelated pending response.
- Cancelling all shared provider work on caller cancellation would require a
  separate shared-refresh cancellation contract and could disrupt other callers.
- Clearing all failure and quota state on cache replacement would bypass valid
  locks; deletion cleanup has a separate D01-R12 scope.

## Consequences

In-flight provider requests continue to settle; they cannot publish stale cache
state or queue a stale token write. Already dispatched persistence retains its
existing repository semantics. Shutdown drains queued writes but does not add a
new drain/cancellation contract for provider refreshes.

The cloud-account owner's durable two-operation invalid-grant confirmation and
provider retry policy remain unchanged. Its global health/cache effects now have
their own [context-ownership decision](../security/2026-09-02-account-health-and-openai-media-hardening.md).
Account-load publication now has its own
[in-memory generation guard](2026-10-16-account-cache-load-publication.md).
All deletion entry points and complete quota/capability cleanup remain D01-R12
obligations. The lease-local guard must not be reported as
complete account lifecycle acceptance.

## Verification

All eight initial lifecycle negative controls failed before the fix. Controlled
policy and production-lease tests cover delete/replacement/credential changes
while refreshing, replacement dispatch before old settlement, stale failure
isolation, successful coalescing and token rotation, deferred writes before and
after account-store reads, preserved diagnostic causes, and deletion during project
discovery. Existing refresh-service tests retain two-strike, recovery and serialized
side-effect behavior. Evidence is recorded in the
R12 refresh lifecycle report (local artifact `D01-refresh-lifecycle-implementation.md` in the 2026-10-11 review collection).
No real credentials or live provider acceptance are used in this slice.

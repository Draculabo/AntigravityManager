# Agent Note: Project discovery failure cache

Status: implemented

## Problem

Account hydration coalesced simultaneous project lookups, but every later request
retried a failed lookup. A completed lookup also inserted its captured entry into
the cache after an account could have been evicted or replaced. Deferred project
persistence could then target another account identity under the same ID.

## Decision

The account-lease project policy owns a 300-second failure cache measured from
settlement and a coalesced promise per live token entry and credential context.
Weak keys keep deleted entries from becoming permanent retained cache state.
Known valid projects take precedence; fallback use is never successful discovery.
Existing provider timeouts and OAuth refresh ownership remain unchanged.

Entry identity and captured refresh/client/email/proxy context guard every probe
result. Explicit invalidation retires that context without cancelling unrelated
OAuth refresh work. Replaced entries can begin discovery without awaiting old work.
The hydration persistence queue carries the same context and discovered-value
guard through the service callback and checks it again after the store read.

Current behavior belongs in [account leases](../../../../docs/modules/proxy-gateway/account-leases.md#project-discovery-failures).

## Alternatives considered

- Retaining account-ID-only locks would let replacement identities join obsolete
  work and inherit its result or failure cache.
- Treating fallback as a discovered project would persist an unsupported success
  and prevent recovery after the failure interval.
- Clearing failure state on every access-token refresh would repeatedly probe
  without an account identity change.
- Adding a detached lookup timeout would leave provider work running without an
  established cancellation contract. Provider timeout ownership remains unchanged.

## Consequences

A provider that recovers immediately can remain undiscovered until the interval
expires, unless a valid project or explicit account-context invalidation arrives.
Late project work cannot revive deleted cache state; this does not establish the
remaining D01-R12 guarantees for OAuth refresh, quota work or already started writes.
No credential location, database schema, protocol field or durable format changes.

## Verification

The initial regression probe found 14 failures among 20 controlled scenarios.
Coverage includes TTL settlement and expiry, invalid and rejected discovery,
single-flight requests, per-account isolation, identity changes, deletion/reload,
authoritative project updates and deferred persistence before/after store reads.
Real lease tests exercise the service callback and invalidation wiring with
synthetic accounts and in-memory stores. Executed checks and remaining limits are
recorded in D01 R8 evidence (local artifact `d01-r8-implementation.json` in the 2026-10-11 review collection).
Live provider and packaged-client acceptance remain deferred by the rollout contract.

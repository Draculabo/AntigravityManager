# Agent Note: Success-only account affinity

Status: implemented

## Problem

Token hydration published session affinity before an upstream request succeeded.
Account-first selection also retained an unconfirmed replacement. A failed or
cancelled candidate could therefore change future account selection. Removing
bindings by account ID alone would let an older failure erase a concurrent success
on either the same or a replacement account.

## Decision

The account-lease owner retains pending affinity in a weak map keyed by its exact
leased account object. Preparation captures committed record identities before
asynchronous selection and hydration. Explicit protocol success commits session
and account-first affinity. Qualifying failures compare the captured records before
deleting them. Every commit creates a new record, protecting concurrent successes
even when account IDs are equal.

The lease checks cache-entry identity, current OAuth/validation eligibility and a
session-clear epoch before committing. Repeated success callbacks are idempotent;
grace can still commit after an earlier failed normal send. No new public protocol
field, database format, credential location or durable pending state is introduced.

Generation commits after the adapter receives a successful upstream result. Stream
establishment is the commit point; later stream failures do not revoke the binding
or cause replay. Token counting first validates the count. Raw diagnostic requests
commit only for HTTP 2xx. Current contracts are owned by
[account leases](../../../../docs/modules/proxy-gateway/account-leases.md#successful-account-affinity).

## Alternatives considered

- Retaining early session or account-first publication would leave the same failure
  observable through a different scheduler.
- Deleting by session or account ID without record comparison would lose concurrent
  successful bindings.
- Waiting for a complete stream would change the agreed upstream-status commit
  point and the existing behavior of long-running streams.
- Putting pending metadata on returned tokens would leak lease state into the
  cloud-account domain model and complicate unrelated callers.

## Consequences

Direct lease callers must explicitly commit successful use. Callers that only
inspect or prepare a token do not establish affinity. Failed account preparation
can still have independent token/project-cache or deferred persistence effects;
this change neither rolls those back nor rewrites their ownership.

An explicit session clear invalidates older pending commits. Reloaded token-cache
entries cannot be confused with old leases, even when account IDs match. Success
does not bypass current validation or OAuth disablement. Existing quota locks,
image permits, retry allowances and signature recovery remain separate policies.

## Verification

The real lease's negative control failed all ten initial scenarios before the
change. Controlled evidence includes pending/success/failure selection, commit-time
TTL, same/different-account concurrent success, account-first retention, grace,
idempotence, clear/delete/reload/disable and four protocols' unary/stream boundaries.
Synthetic upstream adapters and in-memory account stores avoid real credentials.
The implementation report and executed checks are recorded in
D01 R6 evidence (local artifact `d01-r6-implementation.json` in the 2026-10-11 review collection).
Live-provider and packaged-client acceptance remain deferred by the user's rollout
contract; controlled success does not establish those results.

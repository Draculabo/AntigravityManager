# Agent Note: Request completion order and eligibility

Status: implemented

## Problem

Identity/token equality did not order concurrent requests in the same account
context. An earlier lease could apply its late success or error over newer request
state. Stored eligibility could change before cache reload, including while quota
or project lookup was pending.

## Decision

The lease owner numbers issues per cache entry and advances a weak account-wide
fence when a completion is accepted. A newer issue alone does not supersede earlier
work. Success and error admission, session commits, grace reuse and error-driven
quota reconciliation share the fence. Existing protocol output and success timing
remain unchanged.

Recovery and issuance require current OAuth/validation eligibility and reject newly
observed, qualified hard quota against the entry's quota baseline. Diagnostic status
labels and the existing already-loaded quota scheduling policy remain unchanged.
An observed eligibility loss invalidates issued leases even after recovery; fresh
leases can proceed. Shared lease writeback guards enforce persisted health gates
inside the mutation transaction. Quota publication checks them again after commit.

Current behavior is in the [lease reference](../../../../docs/modules/proxy-gateway/account-leases.md#request-completion-order-and-eligibility).

## Alternatives considered

- Arrival/completion order lets a slow old request erase newer protection.
- Superseding on issue would discard useful old observations before a newer
  request has produced a result.
- Model-only fences cannot order cleanup of shared account locks. Separate global
  and model observation clocks would require a broader protection-state redesign.
- A persisted completion clock would add migration and recovery obligations.
- Serializing provider calls would introduce head-of-line blocking and retained
  work rather than governing completion effects.

## Consequences

The conservative account scope can suppress an older model-specific observation
after another model's newer result. Request output/errors still reach their caller.
There is no new provider retry, persisted counter, schema or dependency.

Committed quota remains committed if eligibility changes before publication; later
cache effects stop. Restrictive error reporting does not restore eligibility.
Quota probes additionally share the cloud-account observation fence described in
the [quota ordering decision](2026-10-17-quota-observation-order.md); ordinary
generation completions remain governed by this separate gateway clock.
Unobserved external eligibility change/reversal and cross-owner gaps
after the final check remain limits. Real acceptance remains deferred.

## Verification

Six initial controls fail before implementation. Controlled request barriers cover
old success/error after a newer completion, two real protocol-service requests in
reverse completion order, pending quota reconciliation, and eligibility changes
before cache reload. Tests preserve output/errors and permit an older completion
when a newer lease is merely issued.

Temporary native SQLite cases cover queued quota writes, post-commit publication,
deferred project persistence, block/recovery and validation deadline recovery.
Synthetic inputs and pinned Node 24 isolate this evidence from real profiles.
Packaged Electron and live-provider acceptance remain unverified.

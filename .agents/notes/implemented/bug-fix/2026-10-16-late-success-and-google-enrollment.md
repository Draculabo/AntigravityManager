# Agent Note: Late success and Google enrollment ownership

Status: implemented

## Problem

Generation success retained only an account ID when clearing protection. An old
response could therefore remove newer account/model state. Affinity's cache check
alone could not see a same-value row replacement before cache reload. Google
enrollment used an upsert and unguarded health/quota follow-up after insertion.

## Decision

Generation and stream callbacks retain the original issued lease. The existing
completion proof gates success cleanup and session commits. Stale work still
returns generated output; existing stream success timing and retry budgets remain.

The repository exposes an insert-only operation that returns the parsed stored row
inside the insertion transaction. Enrollment uses its incarnation and complete
token guard for queued health cleanup, post-query checks and the quota transaction.
Health cleanup also compares the insertion's health snapshot to preserve later
failure evidence while the cleanup waits.
An ID collision fails without overwriting a row. A later store read must not adopt
a replacement as this login's insertion. Import's existing upsert contract remains.

Ownership loss is an account-finalize failure with confirmed account persistence.
It does not undo insertion or replay authorization. Ordinary optional query failures
retain best-effort login behavior; returned quota follows successful persistence.

## Alternatives considered

- Checking only IDs or cache entries misses a durable same-value replacement.
- Re-reading after an awaited insert can capture somebody else's replacement.
- Rejecting generated output because account ownership changed would alter protocol
  behavior without improving ownership of the separate cleanup effect.
- Adding a global completion sequence would change unchanged-context ordering,
  which is a separate D01 decision and requires its own evidence.

## Consequences

No database format, credential location, IPC projection or dependency changes.
Completion checks reuse the prior incarnation proof and its fail-closed diagnostic
policy. Provider calls already dispatched cannot be undone. Email admission now
follows the [transactional duplicate decision](2026-10-17-google-enrollment-email-admission.md).
Unchanged-context completions retain their separate ordering decisions; cross-owner
effects after the final check remain a separate obligation. Real acceptance remains deferred.

Current behavior is in the [lease reference](../../../../docs/modules/proxy-gateway/account-leases.md#late-successful-responses)
and [enrollment reference](../../../../docs/modules/cloud-account/overview.md#google-enrollment-follow-up).

## Verification

Initial valid controls produced twelve failures and one pass before implementation.
A separate finalization control reproduced clearing newer same-context OAuth evidence.
Focused tests exercise protocol output, image-stream completion, durable replacement
before cache reload, session affinity, insert-only collision handling, four enrollment
wait/commit points across deletion/recreation/token rotation, optional query failure
and diagnostic persistence certainty. SQLite runs use temporary synthetic profiles
under pinned Node 24. Packaged Electron and live-provider acceptance are unverified.

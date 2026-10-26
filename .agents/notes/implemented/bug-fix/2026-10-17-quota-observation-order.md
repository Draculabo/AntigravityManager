# Agent Note: Quota observation order across owners

Status: implemented

## Problem

Identity/token guards do not distinguish concurrent quota observations within the
same account context. Manual refresh, monitor, enrollment, warmup and gateway quota
probes can finish out of order. A late result can overwrite newer quota or restore
state after a newer failure, including after waiting for credits or a queued write.

## Decision

Cloud-account owns a narrow process-local quota observation fence shared by these
five writers. Each admitted observation receives an account-scoped sequence. Its
accepted quota response or terminal failure supersedes earlier observations;
issuance alone does not. Identity/token and incarnation guards remain independent.
Successful quota admission precedes optional credits, and the existing 401 recovery
stays within one observation. No retry or provider serialization is added.

All owners close observations in finally blocks. Keep the accepted watermark until
every concurrent observation drains, including while an older result waits after
the newer invocation has returned. Then remove the account's transient clock.
The monitor retains its observations through notification and warmup admission;
the warmup follow-up owns a new observation after generation. Existing billable
generation history is not undone by a stale quota result.

The [current contract](../../../../docs/modules/cloud-account/overview.md#quota-observation-ordering)
owns admission timing and effect scope. This adds quota ordering to, rather than
replacing, the [request completion decision](2026-10-17-completion-order-and-eligibility.md).

## Alternatives considered

- Completion-arrival order allows an older request to erase newer evidence.
- Invalidating on query start discards useful results before any new result exists.
- Separate per-entry clocks cannot order the same database row across writers.
- Serializing remote requests adds head-of-line waits without governing delayed
  writes and presentation.
- A durable counter adds schema, migration and recovery obligations unnecessarily.

## Consequences

A newer terminal failure preserves previously committed quota while blocking older
recovery. A superseded enrollment finalization keeps confirmed insertion, with a
diagnostic failure rather than automatic login replay. Guarded writes are separate
transactions: a previous quota commit is never falsely described as rolled back.
Optional credits retain their fallback behavior, using current stored metadata at
monitor/warmup probe admission instead of an old scheduling snapshot.

The fence is local to the profile owner; independent generation completions and
unobserved external changes are not globally ordered with quota observations.
Existing provider deadlines still own outstanding network work. No credential
location, data format, schema or external protocol changes.

## Verification

Synthetic native-SQLite barriers exercise reversed result order across the five
entry points, quota/credits waits, queued writes, partial commits, late failures,
monitor notification/warmup admission and enrollment persistence certainty.
The initial corrected controls expose 12 failures before implementation, with two
existing behaviors passing. Adjacent lifecycle tests and final mechanical evidence
are recorded in the implementation report (local artifact `D01-quota-observation-order-implementation.md` in the 2026-10-11 review collection).
Real-account, client interoperability and packaged acceptance remain deferred.

# Agent Note: Refresh caller writeback ownership

Status: implemented

## Problem

The OAuth owner checked its own health transitions, but manual quota refresh and
monitor callers still wrote the returned token, quota and status by account ID.
An old provider success or rejection could therefore change a replaced account.
Checking a separate asynchronous read before writing would leave a read/write gap.

## Decision

These callers capture primitive account/grant/client/proxy/access-token context.
They pass a synchronous guard to the owning repository's existing update methods.
The guard reads the current row and executes alongside the mutation in one SQLite
transaction, before any write. The existing storage schema and unguarded caller
contracts remain unchanged. The guard is a trusted same-process callback, not a
new IPC or external contract.

The operation advances its expected context only after its own token write and
checks again after awaited work. Stale results cannot become success hooks,
cached-quota fallback, new login-expired classification or replacement status.
The monitor logs the stale failure, excludes that observed account from its poll
effects and continues other accounts. Existing provider retry/cadence rules remain.

The validation-health owner passes the same guard to its write and rollback and
checks it before cache reload. Failed rollback retains both failures in an
aggregate error with the original cause. It does not overwrite replacement health.

Current behavior belongs in
[OAuth refresh ownership](../../../../docs/modules/cloud-account/overview.md#oauth-refresh-ownership).

## Alternatives considered

- A check only after provider return would miss replacement during later credit,
  health or persistence waits.
- An awaited read followed by an unguarded update would leave a write-time race.
- Holding an account lock across provider I/O would delay fresh work and would not
  constrain independent import/deletion callers.
- A new durable generation or schema migration is unnecessary for differing
  contexts in this slice and remains a separate same-value replacement decision.
- Reclassifying stale work as OAuth expiry would wrongly ask the user to sign in
  again and could apply a failure to valid replacement credentials.

## Consequences

Guarded writes can fail explicitly after earlier effects already committed. No
provider replay, operation-wide rollback or automatic retry is added. The native
transaction covers its own synchronous read and write, not the provider operation.
Credentials remain in process and are not added to logs or transport payloads.

Identical-value delete/recreate, concurrent quota result ordering in an unchanged
context, unguarded switch/import writers, late generation penalties,
persisted preference cleanup and effects delayed beyond a final check remain
D01-R12 obligations. Existing notes retain their still-active limits.

The later [warmup/backfill decision](2026-10-16-warmup-and-backfill-writeback.md)
extends context checks to warmup and legacy OAuth backfill, including whole-token
metadata protection and accepted-effect history. The remaining obligations above
still apply; this record is not fully superseded.

## Verification

Controlled service tests cover stale success/rejection, credits, token precheck,
401 recovery, continuation on another monitored account and effect suppression.
The real SQLite tests use temporary profiles and the installed Electron ABI to
check rejection across all five guarded field writers and ordinary advancement.
They do not use real accounts or establish packaged/live acceptance. See the
D01 writeback report (local artifact `D01-refresh-writeback-implementation.md` in the 2026-10-11 review collection).

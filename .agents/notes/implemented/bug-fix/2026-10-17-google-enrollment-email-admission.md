# Agent Note: Atomic Google enrollment email admission

Status: implemented

## Problem

Two Google enrollment operations can both pass the awaited duplicate check before
either inserts its newly generated account ID. An import can similarly claim the
email while login preparation waits. The email index is non-unique, and a malformed
stored token is omitted by the early account-list lookup rather than reserving its
existing email.

## Decision

The insert-only repository method checks stored email metadata in the same
synchronous SQLite transaction as insertion and incarnation readback. It uses
an immediate transaction so the write reservation precedes the read, avoiding a
deferred read-to-write upgrade. Duplicate matching preserves the early lookup's
JavaScript lowercase comparison; it does not apply provider-alias heuristics.
No credential decoding is required to establish that an email is already stored.

The repository throws a typed email-admission conflict before any insert. Enrollment
alone maps that conflict to its existing duplicate-login error, retaining its cause
and recording the `account-persist` stage with no account insertion. An early
duplicate retains the original stage. Ordinary SQLite errors are not reclassified
by their messages. There is no new retry, login replay or replacement of the winner.

The [current contract](../../../../docs/modules/cloud-account/overview.md#google-enrollment-email-admission)
defines the public diagnostic and remaining upsert boundaries. The prior
[enrollment follow-up decision](2026-10-16-late-success-and-google-enrollment.md)
still owns incarnation checks, committed insertion and guarded finalization.

## Alternatives considered

- Checking again in the service still leaves a gap before insertion.
- A process-local email mutex cannot protect the persisted identity against imports
  and retains reservation cleanup obligations across failure and deletion.
- A unique email index changes the durable schema and needs a historical-duplicate
  migration plus an explicit decision about all existing upsert contracts.
- SQLite `lower()`/`NOCASE` has different non-ASCII semantics from the existing
  JavaScript comparison. Metadata-only scanning preserves the current behavior
  without reading full credential payloads.

## Consequences

The first committed registration keeps its row, token, incarnation and active
state. A losing attempt stops before quota/failure-state follow-up. Token exchange
and identity preparation may already have occurred; rejecting insertion cannot undo
those earlier effects. A failure after the winner's insertion remains confirmed
and does not permit a second duplicate registration.

The short insertion transaction scans email metadata and uses the existing SQLite
busy timeout. No schema, storage format, credential location, management protocol
or dependency changes. Historical duplicates are not repaired and explicit
unguarded upserts keep their existing semantics. Fresh registration after explicit
deletion checks current storage rather than a persistent in-memory reservation.

## Verification

Controlled native-SQLite enrollment overlap initially reproduces eight failures
and five passing controls. Cases cover both winners, case folding, import ordering,
unrelated emails, non-normalized aliases, unreadable stored credentials, insertion
rollback, explicit retry after failure/deletion and confirmed finalization failure.
Diagnostic tests cover desktop and real private-management transport with simulated
Google responses, and distinguish arbitrary storage errors from typed conflicts.
Results and environment limits are in the
implementation report (local artifact `D01-google-email-admission-implementation.md` in the 2026-10-11 review collection).
Live-account, client interoperability and packaged acceptance remain deferred.

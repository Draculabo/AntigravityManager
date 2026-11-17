# Agent Note: Caller ownership for stored Responses history

Status: implemented

## Problem

An accepted proxy credential previously allowed reading, deleting or continuing any
known public response ID. Account affinity did not authorize access to that history.
Old records have no reliable caller provenance: neither the current configured key,
the selected Google account nor the first reader can establish their creator.

## Decision

The user confirmed caller isolation without encryption on 2026-10-17. Responses
history records carry a versioned SHA-256 caller digest derived from the existing
canonical proxy credential identity. Equivalent Bearer/API-key presentations agree;
anonymous local mode has its own identity. No raw credential, encryption key or
new credential store is introduced. Conversation content remains plaintext.

HTTP create/continue/read/delete and WebSocket durable-history admission use the same
ownership check before history materialization and retention renewal. Unknown,
foreign, missing and expired records use the existing not-found behavior. Internal
trusted store reads remain available for diagnostics and codecs; they are not public
authorization operations. New parent links must have the same owner as their child,
and durable decoding rejects malformed ownership and mixed-owner parent chains.

The current store reuses `openai-responses-sessions.json`. Its generic durable envelope
remains version 1; the Responses record codec requires initial identity and a `sha256-v1:`
owner digest. Missing ownership decodes as `unknown`, which cannot be claimed or used
through the public history API.

The [initial identity decision](../bug-fix/2026-10-17-responses-initial-identity-metadata.md)
applies the initial task identity to the existing active file without importing old
records. The user explicitly accepts that old cursors become unavailable. Strict decoding
drops records missing either caller ownership or initial identity during the first store
hydration, then the atomic writer replaces the active file. A separate historical filename
is ignored, never imported or used as fallback.

New writes retain the existing atomic-file and fail-open persistence policy. A failed
replacement may leave only the prior bytes on disk and new history in memory; the failure
is diagnosed by the durable owner. A successful generation or `flush()` does not prove
persistence after such a failure. Cancellation or failed generation cannot publish
completed history through the HTTP operation.

The [WebSocket lifecycle decision](../protocol/2026-11-17-responses-websocket-lifecycle.md)
reuses this writer and ownership contract for saved WebSocket completions and
reconnection. Explicit transient socket responses retain only their connection history.

Credential rotation changes history identity. Restoring a trusted original credential
restores access to its retained records, but the application never guesses aliases.
Open mode remains unauthenticated: freely chosen headers are not proof of distinct
human users, and all header-free clients share the anonymous scope. ProxyGuard remains
the authentication owner; this feature does not turn open mode into authentication.

WebSocket transport-local transcripts remain connection-owned and follow existing
retention and `store:false` behavior; this change does not add durable WebSocket
publication or authorize a cursor from another connection. Signature lookup from
a restored HTTP/durable cursor follows history admission before executing generation.

## Alternatives considered

- ID-only lookup preserves old cursor compatibility but cannot enforce caller isolation.
- File encryption was explicitly declined and would not establish caller authorization.
- Assigning today's key or allowing first-reader claims invents provenance.
- Importing old records as owned or scanning old caches bypasses the boundary.
- A separate versioned file would preserve the old active file for downgrade, but the user
  chose direct replacement and accepts losing old cursors.
- Assigning unknown old records to an owner or importing them into the active file would
  invent provenance. The strict decoder drops them instead.

## Consequences

The new codec runs at the existing `openai-responses-sessions.json` path. Its first
hydration rejects old records and atomically replaces them with the current set; no
migration backup is created. Any separate `.v2.json` file is left untouched and ignored.
An older binary started against the reused path may reject and replace current records, so
downgrade requires restoring a copy made before the cutover. All retained records remain
plaintext and rely on OS account permissions. Earlier cursors cannot be continued by the
new codec, even when their caller ownership is valid, because their initial task provenance
was not retained.
Changing or re-enabling a credential is an administrative action, not part of recovery.

## Verification

The completed v2 ownership matrix passed 283 tests in 28 files, with zero failures
or pending cases. It used synthetic callers, temporary files, guarded HTTP and
loopback WebSocket admission. It covered foreign reads/deletes/continuations,
parent ownership, plaintext persistence, restart, old-file preservation,
cancellation and injected write failure. Removing caller admission and
cancellation-publication checks produced the expected regression failures;
production source was restored byte-for-byte. Type, focused lint/formatting,
runtime/type boundaries and Agent contracts passed for that slice.

The initial matrix also exposed a stale lease fixture and intermittent durable
replacement behavior. Later passing runs alone did not establish that variability's
cause. Subsequent investigation captured Windows `EPERM` during atomic replacement;
the conflicting Windows handle owner remains unidentified. The local reports
`D03-history-owner-implementation.md` and `D03-retention-replacement-implementation.md`
under ignored `artifacts/` retain the detailed investigation; this note preserves
its evidence limits without requiring those reports in a checkout.

These are historical v2 results. The earlier fresh-v3 initial-identity matrix passed
530 tests in 42 files, but it predates the user's in-place reset decision and does not
verify replacement of the active file.

The current 2026-10-18 focused D03/D05 run passes 180 tests across 16 files under
Node 24.22.0 on Windows. It includes active-file replacement, older-filename isolation,
caller ownership, restart, and tool compatibility. The Agent contract check passes
28 checks, and focused ESLint and Prettier pass. The HTTP/WebSocket fixture logs that
the source-mode audit worker JavaScript entry is absent while its assertions pass;
these tests do not establish built-worker behavior. The
[upgrade guide](../../../../docs/upgrade-guides/next/responses-history-ownership.md)
records the hard-reset action and downgrade boundary. Real profiles, providers and
final domain acceptance remain deferred; no real profile migration was performed.

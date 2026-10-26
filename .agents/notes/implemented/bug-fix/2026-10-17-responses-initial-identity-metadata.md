# Agent Note: Responses initial identity metadata

Status: implemented

## Problem

Two controlled diagnostic probes isolate remaining D03 R5/R7/R8 gaps:

- Without a client session hint, new Responses operations use their random response ID
  as the routing root. Equivalent initial text under one caller therefore has different
  logical store identity on each operation and does not align with hint-free Chat.
- Durable Responses input intentionally replaces inline images with small historical
  markers. The next owned continuation preserves its routing root and account affinity,
  but recomputes its task anchor from that reduced transcript, changing the logical store.

Current persisted records contain routing IDs and caller ownership, but not the origin of
the routing ID or a preserved initial task fingerprint. An explicit client ID can resemble
a generated response ID; string shape is not evidence of origin. Omitted image bytes
cannot be reconstructed from a marker. Enlarging caches or guessing ID formats cannot
repair either gap reliably.

The human user accepts applying the current history format to the existing active file
without migrating or importing old records. Old cursors become unavailable, and rejected
entries are dropped when the store first hydrates. Clients must open a new conversation or
replay history they retain. This amendment replaces the original upgrade/import proposal.
No real-profile operation or encryption is authorized.

## Decision

Under the confirmed fresh-history scope, the Responses owner retains small versioned identity
metadata recording explicit-client versus content-derived origin and a canonical initial
task fingerprint. The metadata contains digests and a closed origin discriminator,
not duplicated media, new raw API keys, encryption or a new credential location.

The shared protocol anchor owner defines a canonical task-fingerprint contract that
is composed with current initial instruction/tool identities. A full media transcript
is not retained just to preserve an identity. Equivalent new hint-free tasks use
the content-derived scope; a response cursor will only restore the owned history and its
identity metadata. Existing public response IDs and signature provenance checks stay
under their current owners. The history owner is checked before metadata is consumed.

The durable codec validates a bounded metadata version, closed origin and fixed-size
digests. Missing origin/task metadata in the new file is rejected without guessing
from an ID's prefix or assigning omitted media a fabricated fingerprint. Old records are
not imported or searched. Explicit hints and later instruction/tool
changes follow the confirmed D03 rules rather than freezing the entire conversation
under an obsolete context digest. A controlled compaction/reset case preserves the initial
task digest; complete compaction behavior remains owned by the D13 contract.

Implementation reuses `openai-responses-sessions.json`. The strict current decoder rejects
old entries that lack caller ownership or initial identity metadata; first hydration drops
those entries and atomically writes the current-format store. Old response IDs return the
existing not-found behavior. A separate older filename is not opened, imported or used as
fallback, and runtime reads never fall back to another caller after a miss.

The upgrade guide describes the in-place history reset, new-conversation requirement,
write-failure behavior and downgrade limits. Shared identity namespace changes are explicit;
old cache keys are not consulted. Verification uses isolated synthetic files. Real profile
and model acceptance remain deferred to the agreed final phase.

## Alternatives considered

- Inferring origin from `resp_`/UUID spelling can misclassify a legitimate explicit hint.
- Re-reading omitted image bytes is impossible; retaining every original image violates
  the established bounded durable history behavior.
- Hashing the shortened transcript again changes identity and does not solve the defect.
- Freezing one full-context store digest forever ignores legitimate initial instruction/
  tool changes; the preserved task fingerprint and current context need separate ownership.
- Importing old records requires provenance that was never retained; the human user
  accepts restarting old conversations instead of adding migration/legacy branches.
- Retaining or translating old entries would require inventing missing caller/task provenance.
  The user accepts losing those cursors and chose the direct reset.
- A separate versioned file would keep old records dormant and preserve an easier downgrade
  path, but would not replace the active history in place.

## Consequences

The active filename remains `openai-responses-sessions.json`; the generic durable envelope
remains version 1. Initial identity is `{version: 1, origin: 'client' | 'content',
initialTaskFingerprint}` with a 64-character lowercase hexadecimal digest. The shared
logical store namespace is `session:store:v2`, with protocol signature projections under
`scope:v5`. Explicit affinity retains `session:affinity:v1`.

Old cursors cannot be resumed after upgrading; the user explicitly accepts that boundary.
The first hydration drops unsupported entries from the active file. Any separate older
filename remains ignored. The application creates no migration backup, and an older binary
may discard records it cannot decode if it is started against the reused path. New records
retain plaintext conversation data under the existing profile access policy. A failed atomic
write can leave a completed response available only in memory; persistence retains its
diagnostic and does not imply a successful disk commit. Existing capacity and expiry limits
apply.
This decision does not add encryption, a new API key, an automatic model retry or tool execution.

## Verification

- Regression checks invert the original diagnostic outcomes: equivalent hint-free prepared text
  and supported media use common cross-protocol logical identity; owned continuations
  retain their initial task identity after media bounding and restart.
- Different callers, tasks, images, explicit hints and meaningful initial context/tool
  changes remain distinct. A cursor never substitutes for caller authorization.
- Explicit/restored roots, omitted headers, unary/streaming HTTP and WebSocket paths
  carry the identity without exposing raw private content or changing public IDs.
- Old active entries are rejected and removed on first hydration; old cursors are unavailable.
  A separate old-version filename is ignored. Missing, malformed or mixed-owner metadata in
  current-format records is rejected.
- Isolated first-start/restart and failure checks exercise active-file reset,
  expiry/IDs/parents, failed-write reporting and no older-filename fallback. The active
  legacy record becomes unavailable and is replaced; a separate `.v2.json` file stays
  unread. No older binary is started.
- Metadata has a closed codec and fixed-size digest. The in-place format reset avoids
  duplicating full media and retains existing capacity/expiry and persistence ownership.
  No process-memory benchmark is claimed for this metadata slice.
- No real account/provider/profile acceptance is claimed.

The earlier fresh-v3 matrix passed 530 tests in 42 files. Those results predate the
approved in-place reset and do not verify this cutover. The current 2026-10-18 focused
D03/D05 run passes 180 tests across 16 files under Node 24.22.0 on Windows, including
active-file replacement, ignored older filenames, restart, caller admission and tool
compatibility. The Agent contract check passes 28 checks; focused ESLint and Prettier
also pass. The HTTP/WebSocket fixture logs that the source-mode audit worker JavaScript
entry is absent, while its assertions pass; those runs do not establish built-worker
behavior. Real profile/provider acceptance remains deferred.
Broader media equivalence, D12 wrappers, D13 compaction and D16 joint cleanup
remain separate obligations; this slice does not complete D03.

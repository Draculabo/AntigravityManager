# Agent Note: Preserve distinct signed Thought Store turns

Status: implemented

Scope: D04 signed-history matching and ambiguity rejection; broader turn identity remains open.

## Problem

History ingestion, cold hydration and capture deduplication could treat a reused tool ID
as proof of one turn. An earlier signed turn could resolve to a later turn, and both
memory and SQLite could overwrite the earlier record. Fixing lookup alone would not
preserve the record through capture and restart.

## Decision

Within the existing session scope, ingestion matches an equal non-placeholder opaque
signature before tool IDs and fingerprints. Different nonempty, non-placeholder values
cannot merge through either fallback. Capture deduplication applies the same conflict
guard in memory and SQLite. Cold hydration uses the ingestion matcher.

Restoration of a turn carrying a recognized signature requires that exact stored value.
A missing match leaves the request unchanged; it cannot replace the supplied value with
a different stored signature or with an unsigned record. Existing model filtering and
one-use matching remain in force. This is association evidence, not cryptographic
validation or format normalization.

Unsigned matching requires one candidate. A matching fingerprint can distinguish one
reused-ID candidate; multiple candidates remain ambiguous even after another candidate
was consumed. Restoration accepts exact visible text only when unique, never arbitrary
prefixes or a final-turn category fallback. Explicit signatures reserve their records
before unsigned turns, including complete turns. Multiple same-strength history claims
on one record remain unresolved.

Hot capture and SQLite save use the same matcher across the session's candidate
metadata. SQLite does not decode thought bodies for this selection. An ambiguous
incoming record is retained separately rather than overwriting the latest signed round.
Historical ingestion and cold hydration inherit the same candidate rules.

## Alternatives considered

- Lookup-only protection leaves capture and SQLite overwrite paths active.
- New durable turn metadata would address wider ambiguity but is outside this slice;
  it requires a separate ownership and recovery decision.
- Re-encoding opaque signatures for comparison is deferred to D04's explicit format
  boundary work. This slice compares stored bytes without modifying their encoding.

## Consequences

Distinct signed turns can occupy separate records and remain subject to existing
session limits. No schema, durable payload, credential or encryption change is needed.
Previously overwritten records cannot be reconstructed. A rollback restores the older
matching behavior without a format migration.

Missing causal metadata, tool arguments, per-tool parallel signatures and stream-fragment
ownership remain separate obligations. Rejection of ambiguous matching is not a complete
turn-identity implementation. Recognized signature equivalence and recorded model
ownership are covered by their separate implemented notes.
No automatic tool execution or retry is introduced.

## Verification

Five regression cases fail before the fix: exact signed lookup, conflicting fallback,
cold snapshot merge, signed restoration and missing exact restoration. A service test
also covers successive captures sharing one tool ID.

The existing native worker suite adds save/ingest variants with isolated SQLite files,
an earlier-turn upgrade and worker restart. The test assertions run unchanged against
an isolated build of the production worker. Final command evidence and limits are in
the D04 report (local artifact `D04-signed-history-implementation.md` in the 2026-10-11 review collection).

The ambiguity follow-up (local artifact `D04-recovery-evidence-implementation.md` in the 2026-10-11 review collection)
records recovery, hot-capture and isolated SQLite save/ingest/restart regressions.

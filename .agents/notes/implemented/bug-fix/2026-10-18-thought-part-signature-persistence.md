# Agent Note: retain per-part Thought Store signatures

Status: implemented

## Problem

Thought Store previously selected the longest part signature for one whole record.
A controlled probe captured parallel calls with A/B and restored B/B. A scalar cannot
prove which tool or thinking block supplied an opaque signature.

## Decision

The subsequent [D16 round ownership decision](2026-10-10-audit-reclamation-thought-decode.md)
adds schema-3 operation/causal/completion provenance and bounded tool references,
preserving schema-2 entities transactionally. It supersedes the format version below,
not this note's explicit schema-0/1 replacement authority or per-part ownership rules.
Its upgrade guide owns schema-2 copy restoration and schema-3 downgrade restrictions.

The human explicitly authorizes direct replacement of old Thought Store history on
2026-10-18, without migration, old-format fallback or an automatic backup.
Only the dedicated Thought Store tables are in scope. No actual user database is opened
for this implementation's controlled verification.

Schema 2 requires `part_signatures` JSON plus its measured retained signature bytes.
Each thinking part retains its exact range in the stored thought body and nullable
signature. Each function call retains its position, optional ID, original name,
canonical argument digest and nullable signature. Parameters and media are not copied
into this metadata. The scalar signature describes only equivalent signed reasoning
parts; it never supplies a missing tool signature.

The [part codec](../../../../src/modules/proxy-gateway/thought-store/thought-part-signatures.ts),
record matching, hot ingestion, worker, SQLite and cold hydration share that ownership.
Tool recovery needs exactly one source and one destination matching name, digest and
available ID. Position, signature length and consumed candidates do not resolve ambiguity.
Provided opaque signatures remain unchanged. Meaningful signed text is not expanded from
a cache; empty reasoning ranges and trailing whitespace remain separate.

Text and its metadata are merged as one value. Missing signatures can enrich an identified
record; conflicting signatures keep records separate. Metadata counts toward session
retention, cold-load admission, the memory cache, the worker queue and content transfer.
An oversized record retains only its existing summary/digest form, without recoverable
signature metadata. The detail owner transfers signature metadata in a separate bounded
content segment, rather than expanding RPC metadata.

The [database initializer](../../../../src/modules/proxy-gateway/thought-store/thought-store.database.ts)
resets schema 0/1 tables in one immediate transaction, creates schema 2, reads its columns
and commits the version. Failure rolls back and closes the opening connection. No automatic
retry or manual database/WAL/SHM deletion is added. Future versions and databases with
unowned tables/views/triggers are refused. Adjacent feature stores are outside this owner.

No encryption, raw API-key storage, tool execution or provider retry is added.
The [upgrade guide](../../../../docs/upgrade-guides/next/replace-thought-store-history.md)
states irreversible cache loss and the empty-store downgrade procedure.

## D16 recovery permission follow-up

Durable tool references govern recovery after capacity eviction as well as expiry.
Recent/older reads batch the exact session/operation query; warm replay requests a
bounded permission snapshot without copying diagnostic bodies. Acknowledged memory
captures retain durability through a weak record association, rather than an
unbounded operation index. Unavailable snapshots deny durable tool recovery and
report the owning read failure, while unacknowledged current captures keep their
existing finite fallback. Deletion and cancellation leases still guard publication.
Diagnostic detail reads retain original signatures. No format migration is needed.
The earlier legacy and D04 ownership obligations remain active; this closes the
warm durable-eviction gap. Unproven legacy/history/partial tool signatures remain
diagnostic only, because their original completion and expiry cannot be established.
Enrichment follows unique tool identity across layout changes and cannot recreate
an evicted signed reference after maintenance frees space. The production Worker regression fails against the
prior compiled worker because its recent load restores an evicted signature.

## Alternatives considered

- Keep or select one first/latest/longest signature: rejected by the A/B to B/B defect.
- Migrate old rows with null ownership: rejected by the human's explicit replacement decision.
- Reuse tool ID/name columns for opaque objects: rejected because it corrupts their meanings.
- Duplicate a whole thought body per tool: rejected because it wastes bounded storage and
  cannot express separate reasoning-block ownership.
- Disable all recovery: rejected because unique per-part evidence can restore legitimate history.
- Remove database files before opening: rejected because SQLite transactions provide a bounded
  reset and rollback without manual sidecar handling.

## Consequences

Old cached thinking/signatures disappear after the first successful schema-2 open.
They cannot be reconstructed by this implementation. Accounts, traffic audit, configuration
and Responses histories retain their own storage behavior. Older binaries cannot read
schema 2; downgrade requires a fresh profile or explicit removal of this dedicated cache
while every app/core process is stopped. This procedure does not recover old history.

More opaque signatures are retained locally in plaintext under the existing profile policy.
Their association proves neither cryptographic validity nor provider acceptance. Identical
parallel calls with insufficient identity remain cache misses. Lost signatures remain lost.

The [earlier part-ownership decision](2026-10-18-thought-signature-part-ownership.md)
still governs explicit request signatures and tool-result behavior; this decision completes
its missing per-tool persistence/recovery portion rather than replacing its other rules.

## Verification

Controlled tests exercise service capture, independent parallel signatures, multiple reasoning
ranges, ambiguous IDs/arguments, provided signature preservation, model ownership, hot/cold
merging, native save/load/reopen, version-one reset, transaction rollback, unrelated/future
database refusal and metadata byte limits. The production worker has separate save/ingest
and restart checks; the private detail transport has large-metadata chunk coverage.

Exact commands, pass/failure receipts and limitations are retained in the
implementation evidence (local artifact `D04-part-signature-persistence-implementation.md` in the 2026-10-11 review collection).
The original combined suite and native worker receipt used Node 24.19.0. A 9-file focused
suite (115 passed), TypeScript, focused ESLint, Prettier and Agent Contracts (28 passed) were
rerun under the pinned Node 24.22.0. Real provider/client, actual user profile, packaging and
platform-matrix acceptance remain deferred.

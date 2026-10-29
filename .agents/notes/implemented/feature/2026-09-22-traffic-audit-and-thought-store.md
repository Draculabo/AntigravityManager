# Agent Note: Traffic Audit and Persistent Thought Store

Status: implemented

## Problem

The gateway previously lacked a durable view of complete proxy traffic and physical upstream retry
attempts. Its transient signature/session handling also could not restore full thought text after a
process restart. Existing rejection captures solve a narrower debugging problem and cannot provide
request lineage, retention controls or cross-protocol continuation.

## Decision

Traffic audit and Thought Store use separate SQLite databases, worker threads and bounded queues.
Each worker is a dedicated Electron Forge build entry rather than an evaluated source string. The
feature owns its Drizzle schema and repository; Drizzle handles typed metadata CRUD while the
repository retains direct `better-sqlite3` prepared statements for SQLite PRAGMAs, chunk streaming,
deduplication, retention and checkpoint operations. Worker messages are validated before repository
dispatch, and the main-process queue exposes only semantic commands rather than SQL or ORM objects.
HTTP requests and ordinary IPC operations create parent audit rows; physical provider calls create
ordered attempt rows. Structured credential keys are redacted before enqueueing, media becomes
metadata plus a digest, and sanitized audit bodies are incrementally serialized into 64 KiB chunks.
A unique logical body retains at most its first 100 MiB and records full sanitized size/hash when
the source remains readable. Exact bodies share a payload only within one parent request; no payload
ownership crosses parent requests. Valid streams store a reconstructed response plus any
unrecognized events. Parser failures store credential-redacted raw SSE framing, error offset and
summary rather than a byte-identical upstream stream. The default retention policy is 24 hours for
bodies, 30 days for summaries, 100,000 rows and 256 MiB on disk.
HTTP and IPC summaries are classified as model, auxiliary, IPC or system. Metadata-only admin
events are visible in the system category and count against the same summary age and row limits.
Native Gemini usage is captured for audit before response normalization drops non-parity metadata;
the client response shape remains unchanged. Streaming usage events merge field by field so a
later output-only event does not erase earlier input, cache or reasoning counts. The displayed
input/output totals are never increased by the supplementary cache/reasoning fields.
Disk pressure discards system/admin data before IPC, auxiliary and model records. Queue admission
reserves capacity for model writes, limits background writes to 10% and all non-model writes to
30%, and separately bounds management reads. This avoids letting diagnostic traffic crowd out the
model path while still admitting auxiliary work after background saturation.
The audit database enables SQLite incremental auto-vacuum before schema creation. This unshipped
schema-v4 change archives any older audit database and creates a fresh one; it does not migrate
old audit records. Existing v4 databases gain an ordered partial index over live payloads in place;
the obsolete stored-byte index is removed without changing the schema version or rebuilding rows.
Body eviction drives the join from that index and advances by timestamp and ID, so each traffic
class scans forward instead of repeatedly sorting its remaining bodies. Candidate pages contain
at most 32 rows. Each batch uses the measured disk excess as its stored-byte target. Accumulated
deletions are reclaimed and remeasured before adding a body that would reach that target, because
chunk and index pages can free more space than stored content bytes. This retains batch efficiency
for small bodies without discarding an entire page after one body satisfies the physical budget.
The current retention and IPC polling exclusions are documented in the
[gateway security reference](../../../../docs/modules/proxy-gateway/security.md#proxy-traffic-and-thought-persistence).

A desktop pressure acceptance run exposed another blocking boundary: reclaiming about 46 MiB
from 10,200 synthetic requests delayed a statistics read for 9.124 seconds, even after indexed
batch eviction. The main queue admitted only one command until its final reply, so yielding
only inside the worker could not release queued reads. Audit maintenance now advances a
worker-owned generator and replies with a transport-level yield after each slice. The generic
queue requeues the same command behind peers without resolving it or releasing its admission
reservation. This scheduling primitive contains no audit policy. Audit/configuration passes
serialize in their feature dispatcher; reads and writes can interleave at committed boundaries.
Age/row-limit eviction is also sliced, body work has a 20 ms soft budget, and incremental vacuum
reclaims at most 128 pages before yielding. High-water row IDs and creation-time cutoffs bound
each pass and exclude arrivals, including after concurrent clears reuse row IDs.
Row-limit eviction observes the connection's mutation counter at each yield and recounts
only after interleaved writes, preserving records when a user has already deleted enough
rows without rescanning the entire table after every read-only scheduling turn. Each disk
body batch commits in one transaction before yielding, avoiding a commit per small body.

Thought sessions are keyed by SHA-256 of the presented credential plus a sanitized stable client
session ID. Missing stable IDs are request-local. Thought text and signatures use `RAW1` or `AGZ1`
framing and remain plaintext. Each session is transactionally capped at 200 turns and 64 MiB of
uncompressed thought, with oversized single records reduced to hash and metadata. The store retains
up to 2,000 sessions for 15 days.
Historical turns are matched against a snapshot of the full session in both the in-memory cache and
the SQLite worker transaction. This avoids duplicate appends when clients resend complete history;
a stronger thought can update its matching record. Restoration searches newer records first and
reserves category fallback for the final model turn, preventing a recent thought from filling an
unrelated older turn. Complete thought/signature pairs are not rewritten.

Success timing headers are added at the protocol response boundary, while each physical upstream
attempt updates the request-local clock. The streaming header write waits for first output so
TTFT is known without buffering the complete model response. The exposed session ID is the
client-visible routing ID, not the credential-derived storage key.

Both persistence paths are fail-open. The audit queue defaults to 16 MiB, is capped at 64 MiB and
enforces byte and command-count bounds across all live bodies. Writes never block or replace a
model response, and shutdown draining is bounded. Management is available through typed IPC and
authenticated internal HTTP routes. Detail reads return metadata plus body descriptors; body
content is paged or explicitly streamed in full. The UI only materializes a bounded 4 MiB body
window; search jumps directly to a matching chunk, and Save Full streams to disk. This preserves
full access without allocating a 100 MiB CodeMirror document. Read-only management is excluded
from auditing to avoid recursion; mutations emit metadata-only events. Repair is explicit and
preserves the database plus WAL/SHM sidecars under a
timestamped corrupt backup before creating a new database.
The proxy settings' advanced diagnostics section lists record metadata without reading stored thought
text or signatures. It is collapsed by default; an explicit record selection fetches only that
record's full thought.
Traffic Monitor list queries support an inclusive local-calendar date range backed by the existing
audit timestamp bounds. Request-to-cURL formatting is a pure module reusable by a future CLI;
main-process IPC owns audit reads, current-key selection and direct clipboard writes. The renderer
only sends record IDs and an explicit credential opt-in flag, never a key. The switch resets when
filters change or the page is left. Parent requests can use the current proxy key, while upstream attempts remain
redacted. Historical credentials are neither restored nor stored for this feature.

## Alternatives considered

- Extending the existing 4xx capture files was rejected because it has no relational parent/attempt
  model, is opt-in, and deliberately omits most successful traffic.
- A single database and worker were rejected because audit bursts could delay thought restoration.
- Encryption with an application-managed key was rejected by product decision; strict structured
  credential redaction and collapsed UI disclosure remain mandatory.
- Automatic corruption recovery was rejected because replacing a damaged file can destroy the best
  available forensic and recovery artifact.
- Treating OpenAI `store: false` as a persistence opt-out was rejected because it would make three
  independent storage systems disagree for one request.
- Retaining historical raw credentials for reproducible cURL export was rejected. Existing records
  are redacted, and duplicating long-lived secrets in the audit store would expand exposure and
  require credential migration and deletion semantics.
- Fixed-count body deletion batches were rejected because a body may occupy 100 MiB; a shortfall
  smaller than one body must not expire the rest of its candidate page. A stored-byte range index
  cannot also provide global creation-time order. Request-first joins and offset pagination were
  rejected because they repeatedly scan or sort rows as bodies expire.
- Worker-only asynchronous waits were rejected because the parent queue still waits for the
  active command's reply. A premature successful maintenance reply would let configuration and
  shutdown report completion before reclamation. Moving SQLite to another process or adding a
  second connection would widen ownership and locking without removing the existing scheduler
  bottleneck. Resuming one owned command preserves weighted admission and completion semantics.

## Consequences

The proxy state directory now owns two versioned SQLite schemas and timestamped repair backups. Full
prompts, responses, thought and signatures can contain sensitive user-authored text, so disk access
to the application account is a security boundary. Queue/drop counters and worker health are visible
in the proxy UI. Configuration applies immediately without deleting existing records when disabled.
The audit schema deliberately replaces earlier unshipped formats. Their database and WAL/SHM
sidecars are preserved with a `.schema-v<version>-backup-<timestamp>` suffix before schema v4
starts; no audit rows are copied into v4 because the feature had not shipped. The separate Thought
Store database is unaffected.
The eviction index can be added to or removed from v4 databases without changing record formats;
older code can reopen the database and recreate its previous index. Reverting code cannot recover
body content or summaries already removed by retention.
Cooperative reads can observe partial, committed maintenance results. A failed slice reports its
error and releases the pass so a later configuration can proceed; already committed evictions
remain. Normal close still drains accepted work under its existing deadline, and forced termination
still reports failure. Individual large deletes/checkpoints are synchronous, so the slice budget is
not a hard response-time guarantee. New writes can leave a finite pass above its disk budget.
The cURL clipboard action intentionally exposes the current local proxy key when opted in. It is
not a byte-identical historical replay, and shell history, pasted documents and clipboard managers
may retain the command. The formatter can be reused outside Electron; the credential lookup cannot.

## Verification

- TypeScript public contracts are checked with `pnpm run type-check`.
- cURL quoting and the opt-in clipboard boundary have focused Vitest coverage.
- Sanitization, SSE reconstruction, bounded-queue behavior and corrupt-file preservation have focused
  Vitest coverage.
- `scripts/acceptance/runtime/traffic-audit-native.test.mjs` runs the production-built SQLite workers under Electron's
  Node runtime. It verifies v4 reopen, archive-and-rebuild of v3, paged UTF-8 bodies,
  parent-local deduplication, retention priority, physical disk reclamation and lazy Thought reads.
- `scripts/acceptance/runtime/audit-retention-native.test.mjs` also exercises byte-targeted body
  eviction, reclamation of fragmented small bodies before large bodies, cursor progress across
  tied timestamps and pages, and preserved records on v4 index
  upgrade. These checks do not establish a production maintenance latency bound.
- Native yield-barrier tests verify reads and writes during an incomplete pass and preservation
  of arrivals after concurrent clear/row-ID reuse. Real-thread scheduler tests verify final-only
  completion, queue accounting, error propagation and bounded terminal shutdown.
- Delivery requires launching the real Electron gateway with `pnpm run start`, exercising OpenAI
  Chat/Responses, Anthropic Messages and native Gemini routes with live requests, and inspecting the
  authenticated management endpoints and persisted records. Mock-only success is not acceptance.

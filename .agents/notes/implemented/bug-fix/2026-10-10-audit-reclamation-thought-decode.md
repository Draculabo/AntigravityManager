# Agent Note: Stop ineffective audit eviction and report thought decode failure

Status: implemented

## Problem

Native SQLite reproductions expose four failures. Late producer writes resurrect expired
audit bodies. A reader-pinned WAL causes disk cleanup to delete every request while physical
usage grows. Incomplete reclamation of existing free pages causes another model body to be
discarded unnecessarily. Invalid compressed thought data is returned as successful empty text.

## Decision

Responses metadata has a lazy selected-process owner so explicit management works
before the gateway starts and between Nest lifetimes. Nest receives that same
metadata instance; its FilesService-specific media facade is replaced/disposed at
the gateway boundary. Reopening a separate metadata writer for stopped-gateway
cleanup would leave a retained old writer able to resurrect deleted rows. Lazy
registration avoids profile I/O during presentation composition. Terminal diagnostic
shutdown closes factory admission and strictly flushes existing metadata work.

Joint recovery deletion retains the distinction between a client Thought scope and
an anchored protocol key. Bind ownership at capture or after caller-owned Responses
history is proved, instead of guessing aliases during deletion. Store the optional
digest with retained values; a separate alias database would add another durable
consistency boundary. Live socket registrations end with their transports, and only
executing frames hold request leases. Explicit deletion invokes the two actual
recovery owners after SQLite confirmation; end/maintenance/content invalidation do
not imply persistent peer deletion.

Cross-file deletion is deliberately reported per owner. Strict Responses replacement
failure, unknown legacy provenance and unavailable owners cannot become confirmed
zero or whole-store success. The UI preserves confirmed SQLite counts alongside
partial-cleanup feedback. Do not open another writer when the gateway owner is
absent. The additive ownership field retains the existing JSON envelope; current
upgrade instructions describe private-copy recovery and mixed-binary limits.

Reasoning management uses versioned metadata pages with an explicit high-water ID,
progress validation and byte limits. A complete array is unsuitable once L2 is no
longer pruned with L1; silently truncating it would misrepresent retained history.
The existing external complete-read endpoint still refuses excess data. A new
authenticated metadata route and selected-owner page support bounded traversal.
Mutation receipts count durable sessions and records in the committing transaction;
end reports retained records rather than pretending it deletes history. Existing
HTTP fields preserve their units. Desktop confirmation/cancellation, failed-read
retry and uncertain-mutation feedback consume those owned results. See the
management evidence (local artifact `d16-management-evidence.json` in the 2026-10-11 review collection).

Thought capture now uses request-owned revocable leases. A session string alone lets
an old unary/stream response recreate history after deletion; permanent per-session
generation tombstones grow with every invalidated key. Leases keep the validity with
the active request and short hydration/content read instead. Delete/end/clear block
their scope, invalidate read handles and await a finite accepted-command snapshot
before durable mutation, preserving the existing Worker and unrelated admission.
A timeout does not claim deletion or replay the command. Active-key snapshots protect
maintenance candidates; incomplete snapshots defer the pass. Late content-read replies
cannot mint capabilities after invalidation. The
capture evidence (local artifact `d16-capture-lifetime-evidence.json` in the 2026-10-11 review collection)
separates service simulations from actual queue/SQLite reopen checks and remaining
joint signature/Responses lifecycle work.

D16 separates L1 turn/byte eviction from durable age/session/disk retention. A shared
SQLite admission primitive is justified by the audit and Thought Store consumers;
feature-specific eviction and failure identities stay with each owner. Maintenance
deletes bounded record groups rather than cascading a newly enlarged whole session,
and latches ineffective pressure deletion in the live Worker. A stricter OS quota
or full VACUUM conversion of an old database was not introduced.

The explicit 2026-10-18 schema-0/1 replacement decision still wins over the original
D16 preservation proposal. The earlier experiment preserving schema 0/1 was withdrawn.
The subsequent schema-3 round upgrade preserves schema-2 per-part entities while
retaining that old-cache replacement decision. It adds physical operation identity,
complete causal-prefix candidates, original completion and bounded tool references.
Distinct physical invocations never merge solely because their replies match; failed
streams do not publish complete recovery records. History enrichment cannot renew
completion/TTL. Schema-2 migration rollback and offline private-copy restoration are
executed separately from unchanged schema-0/1 replacement rollback. See
round evidence (local artifact `d16-round-recovery-evidence.json` in the 2026-10-11 review collection).
The public Thought Store configuration now requires its
independent disk field, so owner compatibility becomes 6. Desktop and core upgrade
together; a mismatched owner is refused before attachment, without fallback or
stopping the unrelated existing owner. See the
retention evidence (local artifact `d16-retention-window-evidence.json` in the 2026-10-11 review collection).

Thought reads preflight stored sizes before loading blobs, then bound raw/gzip
decode and complete structured Worker replies. A dedicated read owner replaces
the unbounded management/history paths. The reply budget is separate from the
64 MiB thought-text ceiling so signature metadata does not reduce that existing
capability. Charging JSON escaping to structured Worker messages was rejected:
the actual chunked content contract preserves control characters without expansion.
Transient hydration failure stays unloaded, with a one-second monotonic cooldown
for a later independent request. Retaining loaded-empty forever masks recovery;
retrying the failed model/tool operation would cross the recovery owner's boundary.
The D16 read evidence (local artifact `d16-read-recovery-evidence.json` in the 2026-10-11 review collection)
keeps code, native negative controls and remaining L1/L2 obligations distinct.

Audit hot configuration is guarded by a non-secret content revision checked inside
the existing serialized configuration mutation. A concurrent stale editor must
refresh rather than replay a whole old configuration. Revision metadata is not a
database or JSON-format migration. Queue-budget changes update the existing actor's
admission limits after its configure reply: accepted work drains unchanged. Closing
and replacing that actor on a budget change allowed a second actor to open while
the first drained, so that replacement path is removed rather than wrapped with
another queue or compatibility mechanism. See the
configuration evidence (local artifact `d15-config-application-evidence.json` in the 2026-10-11 review collection).

Make `writing` the required state for chunk admission and both completion paths. Retention
and completed states remain terminal, including duplicate SSE completion. Keep each check
in the synchronous repository/SQLite boundary that owns mutation.

Audit capacity uses globally oldest completed whole-parent requests rather than
traffic-class priority or body-only expiration. The confirmed D15 capacity decision
retires audit age deletion: new/missing limits are 1024 MiB and 100,000 parents,
preserving explicit user capacities. Disk pressure targets 70%; row pressure stops
at its parent cap. Separate admin/drop windows bound non-parent resources without
pretending the parent cap includes attempts. Existing v4 foreign-key cascades own
whole-request deletion, so no durable layout conversion or new indexes are needed.

Inspect checkpoint results and reclaim existing free pages before further eviction.
Bound reclamation and disk rounds, defer on contention/backlog and stop when measured
physical usage does not decrease. Checkpoint busy time is temporarily zero, restored
afterwards, so a pinned reader does not block the queue for five seconds.
Warnings stay in the isolated worker's stderr with numerical fields; importing the application
logger would pull unrelated platform/profile dependencies into this worker.

Physical write admission now checks DB/WAL/SHM and conservative transaction growth
before repository writes, independently of maintenance. Each queued command has only
memory acceptance until its serial disk check runs; no pending command promises disk
capacity. A single nonblocking checkpoint/free-page attempt can precede refusal and
does not delete more history. Missing main files and non-ENOENT stat errors mean
unknown capacity. The service receives only closed reasons over the worker boundary.
Body refusal preserves an actual incomplete prefix; SSE replacement refuses before
discarding its raw representation. Existing raw codecs/schema and Thought Store
ownership remain unchanged. Capture disablement stops new chunks without changing
the model stream; accepted work retains its terminal lifecycle.

Requests active at a pass's captured completion-time boundary, active attempts and
writing bodies remain protected. Establish non-stream response body ownership before
queuing parent/attempt completion: otherwise the weighted queue can interleave
maintenance between completion and body admission. This changes command ordering,
not model execution, and avoids adding a second lifecycle registry or a guessed TTL.

Restart reconciliation uses the owner's process-start boundary, retained across
Worker replacements, to end abandoned audit captures atomically. Provider outcome
stays `in_progress` on disk; a non-null capture-end marker derives the read-only
`capture_interrupted` outcome. This avoids inventing success/failure or changing
the schema/stored outcome vocabulary. Status, usage, duration and error evidence
remain unchanged. Old writing bodies retain actual chunks with incomplete metadata.
Reconciled attempts cease blocking their parent from normal capacity eviction.
Current-process captures remain active; no model replay or inactivity timeout is added.

Successful exact health/model-directory GET probes defer admission by default;
an explicit capture switch restores their successful history. Failed probes retain
their original timing and request-entry generation. Classification remains narrow:
business GET is not a probe merely because it is read-only. Audit disablement still
owns privacy, and response content is not rebuilt to suppress diagnostics.

Explicit clear uses a per-class process generation and a short service admission
barrier. Weak handle ownership and captured serializer/SSE generations stop old
producers; the serial Worker independently rejects delayed old parent/admin inserts.
Whole-scope deletion commits atomically before its generation floor advances.
Failure preserves rows but the local capture boundary can already have stopped old
producers, so callers refresh rather than claiming complete recovery or deletion.
Four counters avoid an unbounded durable tombstone set or schema conversion.

Monitor clear confirmation names the category-wide scope even when filters hide
records, supports cancellation and reports the owner's count. Keeping the current
page avoids remounting away its receipt. Failed acknowledgements trigger readback
invalidation and a fresh confirmation, never an automatic destructive retry.
Exact session filtering is additive to the existing bounded admin query: it compares
the full saved key, preserving tenant prefixes and excluding sessionless admin events.
It does not reinterpret raw client or provider session claims. Old strict selected
owners reject the optional new field rather than silently broadening the query.
No new durable representation or authorization policy is introduced.

Subsequent D15 reconciliation finds that equality alone cannot isolate old HTTP
captures holding raw session hints. New capture reuses D03 canonical hint/credential
scope and protocol-published affinity/store keys, including verified Responses
restoration. Old records stay unchanged: redacted headers cannot prove a safe
backfill. No database migration or routing/Thought Store decision changes.

Session export uses versioned NDJSON in the selected owner. Settled metadata
snapshots bracket streamed bodies; membership/metadata changes or missing bodies
fail before atomic replacement. Explicit row/metadata/time/escaped-byte limits avoid
unbounded materialization. Main retains chooser/path authority; lost acknowledgement
remains uncertain even after a successful file write.

Usage preserves established mapped totals. Adding cache fields to every Claude-
shaped input would double-count gateway input. Scalar provenance and unretained
estimates remain unknown. Versioned timing omits unmeasured stages; old zero is not
evidence of a measured zero. These changes expose uncertainty rather than inventing
provider measurements.

The usage/session evidence (local artifact `d15-usage-session-evidence.json` in the 2026-10-11 review collection)
records pre-fix timing/identity failures, controlled protocol preservation, native
session-snapshot admission, selected-core atomic export and a failing source
mutation with exact restoration. It separates safe fixture evidence from unavailable
installed/real-profile/platform acceptance.

Export validates the saved terminal snapshot page-by-page, rechecks metadata after
the last yielded chunk and verifies stored-byte completion. Missing/changing content
cannot become a successful empty/truncated export. The native file owner retains
atomic replacement and temporary cleanup; a snapshot fully read before later deletion
remains exportable. This is a read-completion boundary, not a lock held across file I/O.

Audit archive accounting is a bounded metadata-only scan of exact owned backup
names, with explicit unknown status on incomplete/inaccessible measurement.
Archives have separate totals outside the live budget and are never automatically
deleted to admit writes. Only numeric counts/bytes/status leave the owner.
The audit required stats shape and new read outcome first required owner compatibility `5`,
using the existing handshake rejection path rather than silently attaching a
desktop to a core whose audit contract differs. Externally managed cores must be
upgraded alongside the desktop; no running core is forcibly replaced.

Loading old age settings is read-only. The first save removing them requires an
atomic exact-byte configuration backup; failure blocks replacement and cache update.
An existing valid recovery copy is preserved. This differs from the independent
model-alias backup's warning-only contract because audit migration removes settings
instead of retaining a legacy projection. The backup remains sensitive local data.

Keep fast gzip and the current durable codecs. Reject invalid compressed thought reads with
record ID and decoder reason; preserve damaged bytes and metadata. Existing service hydration
failure handling continues the model request without restoration and emits its warning.

Current contracts are owned by
[the diagnostic reference](../../../../docs/modules/proxy-gateway/diagnostic-retention.md).

## Alternatives considered

- Repeating eviction until the file reaches its budget consumes useful history when WAL
  truncation is impossible or free pages have not yet been reclaimed.
- Keeping age fields as inert controls hides longer retention and misleads users about
  privacy. Replacing explicit old budgets with the new default would override user choice.
- Expiring just a body or preferring traffic classes breaks the confirmed whole-parent
  chronological window. Deleting additional parents without physical progress sacrifices
  evidence without proving that more space can be reclaimed.
- Unbounded vacuum increases the synchronous worker's maintenance latency.
- Recording a probe first and deleting it on success writes unwanted data and can
  interfere with clear. Deferring all GET requests would hide business operations.
- Flushing the queue before clear does not stop later asynchronous producers.
  UI-only cancellation cannot reject already queued old parent inserts.
- Treating a missing export page as ordinary EOF creates false success and can
  overwrite an existing destination with empty or partial content.
- Recovering at each Worker creation misclassifies same-process live captures.
  Treating every stale capture as a model error fabricates an unknown remote result.
  A guessed age cutoff also creates an unsupported activity timeout.
- Counting only the live database hides retained backup costs. Deleting archives
  automatically destroys recovery evidence; arbitrary directory traversal or opening
  backup contents is unnecessary for truthful size reporting.
- Introducing a separate codec for audit chunks requires a new durable reader
  contract and rollback strategy; our Thought Store already uses fast gzip.
- A separate task semaphore would duplicate the bounded, single-consumer SQLite command owner.
- Treating corrupt gzip as empty text hides failure. Silently dropping only a corrupt row
  creates partial restored history without an explicit failure decision.
- Automatic repair or deletion destroys evidence. Retrying a deterministic corrupt blob
  does not restore its data.

## Consequences

No schema version, codec, SQLite dependency or credential location changes. Configuration
retires audit age fields with a recovery copy. The disk budget combines conservative
admission and a maintenance target; deferred cleanup and active records can exceed it.
Row limits apply independently of a pinned WAL. One large cascade and the complete pass
have no wall-clock guarantee; failed shutdown drain remains explicit. Removed history
cannot be recovered by restoring configuration. Older builds may resume age deletion.
Restart reconciliation changes capture-end/partial metadata without schema conversion;
older readers can label the stored unknown outcome as in progress. A matching current
desktop/core pair shows capture interruption explicitly. Recognized archives consume
space independently of the live audit budget; an unknown inventory never becomes zero.

Damaged gzip changes from successful empty text to a read error. Management sees that error;
model-time hydration retains its existing fallback and does not automatically retry in an
already hydrated memory session. No partial corrupt-session restoration is invented.

## Verification

The pinned-reader baseline deletes 16 requests and grows physical usage from 1,169,224 to
2,701,864 bytes. The fix preserves all 16 and the original file usage; native worker acceptance
also verifies cleanup after the reader releases its snapshot. An 8 MiB free-page fixture
reproduces unnecessary model-body expiry; the fix keeps it complete. A 40 MiB fixture verifies
deferred vacuum and successful reclamation on the next maintenance command.

Native worker tests verify normal and SSE late completion, duplicate SSE completion, paging,
parent-local deduplication, reopen, schema backup/rejection, gzip/raw Unicode
round trips, and corrupt-record preservation. Service tests verify diagnostic hydration fallback.
Actual bounded-queue pressure against a SQLite write lock checks both command and byte budgets,
immediate rejection and persistence of every accepted command after drain.

The D15 admission evidence (local artifact `d15-storage-admission-evidence.json` in the 2026-10-11 review collection)
adds ABI-matched Electron SQLite checks for refusal, retained prefix/reopen, pinned
readers, read-only connections, SSE replacement fallback and a rebuilt real worker.
Service regressions retain disk reasons and settled failures, and stop chunks after
capture disablement. Plain Node 24 cannot load the workspace's Electron ABI 136
binary; matching-runtime validation avoids changing user dependencies or databases.

The final focused suite passes 81 tests in 11 files, with one Electron-ABI-only repository
test skipped under plain Node and its native persistence behavior covered separately.
All 18 unique production-worker native scenarios pass. Two queue-pressure probes attempt
4,400 commands, accept 271 in total and persist all accepted commands with no write failure.
Type checking, focused lint, repository formatting, Agent contracts and the core build pass.

Evidence is retained under `artifacts/audit-pressure-2026-10-10`. It uses synthetic databases
and the installed standalone Node/native SQLite dependency versions in an isolated directory.
The running desktop is not restarted, and live-provider, packaging and other platforms are
not validated by this batch. No changes are committed.

The original counts above describe the 2026-10-10 baseline, not the capacity-window
selection. The D15 window evidence (local artifact `d15-capacity-window-evidence.json` in the 2026-10-11 review collection)
records configuration migration/restore/failure, response admission ordering and
rebuilt ABI-matched production Worker checks. Those replace the obsolete age/class
expectations with global deletion, whole-parent shared-body cascades, separate limits,
active completion protection, 70% reclamation, reader/no-progress stopping and reopen.
No actual older application downgrade or real user profile is used.
The restart/storage evidence (local artifact `d15-restart-storage-evidence.json` in the 2026-10-11 review collection)
adds transactional recovery rollback, same-process preservation, read-only outcome
projection, retained body prefix, global capacity eligibility and bounded archive
inventory checks. Rebuilt production Worker scenarios and deliberately broken
compiled copies distinguish real persistence/accounting evidence from UI mocks.

The probe/clear/export evidence (local artifact `d15-probe-clear-evidence.json` in the 2026-10-11 review collection)
adds real Fastify hook checks for recognized probe suppression and preserved failed,
aborted and business GET capture. Service tests exercise the clear admission barrier
and deferred request generation; rebuilt Worker fixtures reject old queued parents
and admin events and roll back a failed all-scope clear. Atomic export tests preserve
the destination when saved content disappears or changes. Deliberately broken
source and compiled fixtures fail their regression checks, and original source is
restored. These isolated checks do not establish installed UI, real-profile deletion
or live-provider acceptance.

The monitor interaction evidence (local artifact `d15-monitor-interactions-evidence.json` in the 2026-10-11 review collection)
adds pre-fix failures and repaired component checks for clear cancellation/count,
column listener cleanup and storage denial. Selected-owner transport retains the full
saved-session key; a rebuilt production Worker verifies exact tenant-prefix matching,
literal wildcards, paging/count and the system/admin union. This does not establish
installed rendering, OS pointer behavior or real-profile clear.

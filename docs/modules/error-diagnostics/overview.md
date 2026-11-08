# Local error diagnostics

The `error-diagnostics` module owns the independent local error window. Settings →
General provides capacity, source status, paged metadata, sanitized previews, complete
record export and source-scoped clear. Gateway stop/start does not close this window.
Normal refresh logs, HTTP audit, Thought history and Sentry reporting remain separate.

## Process and capacity ownership

Each process registers one optional local logger sink without opening a database.
The selected configuration owner resolves `error_diagnostics.max_storage_mib`: zero
uses the default 500 MiB, and positive integers through 10,240 MiB are accepted.
A valid positive `AGM_INTERNAL_ERROR_LOG_MB` override takes precedence; invalid values
are ignored with explicit provenance. The application never edits environment files.

One deployment window is partitioned equally between app and core. A stopped or
absent role does not donate its allocation. Standalone desktop composition uses the
core's resolved budget, including its environment provenance. A core-only configuration
write cannot confirm that an attached app applied its new share and returns pending
application. The UI also compares every available source's actual allocation against
the selected budget. Unavailable usage is unknown, never zero. During a decrease,
saved capacity, source application and physical reclamation remain separate states.

Role files live in the fixed `error-diagnostics` directory below the profile:
`app.errors.db` and `core.errors.db`. Their independent Worker connections enforce
DB/WAL/SHM measurements, conservative write reservations and a maintenance reserve.
Pressure reclaims oldest complete records toward 70 percent. Each committed slice
has row and byte limits; the owner yields and bounds continuation. Busy checkpoints,
unknown size, read-only/full disk and no progress stop growth and remain diagnosable.
The previously admitted maintenance ceiling survives restart while a capacity
decrease is pending; it permits only bounded reclamation within that earlier ceiling.
New captures use the decreased allocation immediately. Reaching the target also
persists the lower maintenance ceiling.
There is no error-record age expiry and no cross-store cleanup.

## Captures, queries and exports

The logger sink forwards only its message and an actual `Error`, never arbitrary
arguments. The feature produces the existing sanitized stack/cause projection and
validates the closed durable record. Protocol, stage and correlation fields are
available to trusted callers; generic logger errors remain explicitly unclassified.
The gateway's once-only HTTP completion also captures terminal failures when audit
admission is disabled. It reuses D11 generation/transport categories and D15's parent
request reference when available. Untyped response objects are replaced by a fixed
status description, not copied into the error window; absent stacks stay absent.
Capture does not introduce another Sentry submission or change consent.

Physical Google transport sends have independent once-only attempt handles, including
when traffic audit is disabled or no HTTP audit context exists. A failed send records
its actual Error stack/cause, known operation/status/category and attempt UUID even if a
later endpoint succeeds. The request reference is present only when the owning audit
parent exists; a missing reference stays unknown. These are upstream Google transport
records, not an inferred original client protocol. Successful sends, unfinished work,
client disconnects and structured cancellation do not enter the error window. Duplicate
unary/stream completion cannot create another record or increment failure counts twice.
The diagnostic receives no request/response body, headers, account identity or endpoint
query. Sink exceptions cannot change the original attempt outcome or recursively log.

The OpenAI Responses stream owner records per-event mapping exceptions caught by its
existing recovery branch. A later successful event can finish that response while the
original exception remains in the independent error window. Its terminal chunk-decoding
and decoder-flush failure branches also retain the original exception before emitting
the existing protocol error. Records distinguish mapping from decoding with fixed
protocol and stage metadata and an available trusted parent reference.
Recognized cancellation is excluded. Event bodies and tool arguments are omitted,
and a capture failure preserves the existing continuation or termination behavior.

Records larger than 8 MiB are rejected whole; a shortened stack is never presented
as complete. Queued commands have bounded admission. Before allocation or after
failure, at most 64 records and 1 MiB of retained strings remain in memory. Accepted,
persisted, failed, queue-refused and fallback-evicted counts have separate meanings.
Memory fallback does not survive restart. Shutdown refuses a clean-flush claim when
accepted writes fail or fallback remains unpersisted.

Metadata queries return bounded high-water pages without stack bodies. Complete
selected records use the shared expiring sequential chunk capability. Renderer
previews contain at most 64 KiB; a visible truncation indicator distinguishes that
preview from the complete retained record. Main retains at most four temporary
export snapshots. Saving accepts only a reviewed capability ID and uses the native
save dialog, profile destination protection and atomic replacement. The exported
text file contains the complete sanitized versioned JSON record, including stack,
causes and available correlation fields.

Source clear revokes local previews and reads before deletion and changes Worker
capture generation. Old admitted captures cannot republish in the cleared generation;
new errors may be stored afterward. A failed deletion preserves durable rows and
reports an unconfirmed outcome. Other sources and stores are unaffected. An export
checks remote source generation before writing and rechecks local revocation before
atomic replacement. It does not retract a file the user already saved; remote clear
and an already-dispatched filesystem replacement are not a distributed transaction.

## Compatibility and verification

Dedicated error database format 1 refuses future versions, unrelated objects and
role mismatches without resetting data. Existing profile databases and normal log
formats are unchanged. All diagnostic content capabilities now belong to shared
observability, with exact purpose, resource, epoch, cursor and expiry checks.

Owner compatibility 9 requires matching app/core binaries and the new Worker resource.
See the [upgrade instructions](../../upgrade-guides/next/local-error-window.md).
Focused contract, logger, lifecycle, UI and isolated SQLite/Worker tests live alongside
the feature tests. Installed visual, cross-platform, long-run pressure and live-provider
acceptance remain separate from these controlled checks.

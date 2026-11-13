# Diagnostic retention and persistence pressure

This reference describes the gateway's audit and Thought Store SQLite workers.
It covers diagnostic persistence, not compression of the model request or signed history.

## Usage and measured stages

Structured per-attempt stages and the selected-owner HAR export are documented in
[traffic diagnostics](traffic-diagnostics.md). They retain unmeasured phases as
unknown and keep capture representations distinct from raw wire data.

Audit counters retain gateway response totals, cached-input detail and reasoning
detail separately. Cache and reasoning counts are not added again to input/output.
The existing Claude-shaped mapper uses its normalized total for `input_tokens`;
field spelling alone is not evidence of uncached Anthropic input. External counters
must be nonnegative safe integers. Existing scalar records do not retain provider
provenance; the detail UI labels that limitation. Physical-send local estimates
remain in their separate diagnostic owner and are not synthesized from saved bodies.

Cache rate is cached input divided by total recorded input. Missing counts, zero
denominator and inconsistent counters have distinct labels; cached input exceeding
recorded input does not redefine the denominator. Timing reads bounded saved response
headers. `X-Timing-Version: 2` omits unmeasured stages and permits a measured zero.
Earlier zero headers are ambiguous and display unknown. Stages can overlap and are
never summed into duration. TTFT describes the latest upstream attempt whose first
byte was observed, not the sum of retries.

## Physical-attempt usage accounting

Audit schema 5 stores actual upstream input, output, cached and reasoning counters
on each physical attempt. The selected lease snapshots its account incarnation as
a SHA256 digest at send time. Unary responses and raw parsed stream frames supply
the counters before semantic validation, retries or client cancellation can hide
them. Existing once-only completion owns the terminal write. Partial or missing
provider usage stays incomplete; no estimate or parent-response total fills it.

The bounded current-cycle query selects exact physical model IDs and verified Google
subject when available. Otherwise it selects the current account incarnation and
credential digest. It uses the attempt's start time within a half-open
range and a captured owner clock. Count/cache-management operations are excluded.
Repeated generation attempts contribute their own usage once. Request counters
count each parent once within the selected account/model group, so a parent that
uses two accounts can appear once in each account's separate result.

`recordedRequests` equals `countedRequests + ambiguousRequests + missingUsageRequests`.
A missing or partial selected attempt makes the request incomplete. Known terminal
scalars still contribute to the displayed subtotal, including failures/cancellation.
Cache has its own missing counter, bounded by complete plus missing requests. It is
not added again to input plus output. Records without the required identity evidence
are ambiguous and contribute no guessed tokens. Known other subjects and credentials
are excluded.

Retained parents with no attempts or potentially matching missing attempt identity
also contribute an ambiguity marker. These markers use the parent's request-start
window because the physical start/ownership is unavailable, and contribute no tokens.
`ambiguousTimeBasis` explicitly declares `attempt-start-or-unattributed-request-start`.
Grouping deduplicates a marker and any known attempts belonging to the same parent.
Known other accounts/models/incarnations and non-generation attempts cannot create
these fallback markers. Malformed or oversized stream frames also keep the attempt
incomplete, including buffered raw SSE; already observed safe counters remain usable.

Fresh Google enrollment can establish verified continuity across deletion and re-addition.
The subject and credential digests are private and absent from renderer results and
account exports. Legacy data cannot establish a subject. Missing records, disabled
capture, dropped writes and other provider channels prevent a complete billing claim.

The trusted account owner resolves identity before and after a read. Missing or
changed identity fails through the existing audit error surface. Application and
standalone core require matching owner versions. The current audit migration retains
existing audit rows and bodies. Backup, failure and downgrade instructions are in
the [upgrade guide](../../upgrade-guides/next/physical-attempt-usage.md).

## Minute usage trends

Traffic Monitor's model category includes a separate usage-trends panel. It queries
retained local metadata for the recent hour or 24 hours at one-minute resolution.
Time range, account, exact model ID and requested/actual model view are separate
from the request-list filters. Validated local preferences restore these choices
when the panel is reopened; saving failure leaves the current view usable and
reports that the preference was not saved.

The audit Worker groups one database snapshot using the captured owner clock. Time
cohorts use parent request-start time; bucket labels are minute starts, and the
first and last minute can be partial. A request started before the selected range
is outside the cohort even if an attempt completes inside it. Requests and physical
generation attempts are distinct counters. Each selected attempt contributes usage
once; parent response counters are never added. Token-count, cache-management and
other explicitly non-generation attempts are excluded. Historical model attempts
without an explicit usage scope retain the existing legacy generation classification.
A retained model request without any attempt recorded as of the snapshot has
unknown usage. The trends query does not read saved bodies.

Requested-model view groups the parent request's model; actual-model view groups
each physical attempt's model, without inferring it from the requested model.
An account filter selects recorded physical-attempt account IDs. These are historical
records, not evidence of the current account incarnation or official billing cycle.
A request that tries several models can appear in several model rows; row request
counts must not be summed to obtain the overall distinct request count. All views
use the same selected attempt-usage basis, rather than mixing logical response
usage with physical retry usage.

Missing, unsafe, unfinished or partial attempt usage makes the corresponding Token
aggregate unknown, and incomplete-request counts disclose affected records. Known
zero usage is distinct from unknown. No cache or reasoning detail is added again
to input plus output. Minutes with no matching retained records are zero within
this local dataset. Retention, disabled capture and dropped writes mean the chart
cannot establish that no upstream work occurred or reconstruct full account usage.

The result contains at most 1,441 minute buckets and 50 model rows. A truncation flag
labels limited model breakdowns; total counters are aggregated independently from
all matching records. Existing audit admission and response-byte limits still
apply. No schema migration, pricing table, generated request or provider lookup is
introduced by reading these trends.

### Daily activity

The optional activity heatmap shows the latest 30 local calendar days, including
today up to the audit owner's snapshot time. Calendar boundaries follow the
audit Worker's local timezone and account for clock changes. Each day counts
distinct matching retained model requests by request-start time. The panel
shares its account, exact model and requested/actual model filters with the
minute trends. The minute range selector applies to the minute charts only.

An empty date has no matching retained records. Data may be absent because of
retention, disabled capture or dropped writes. The heatmap reads only request
and attempt metadata and loads when expanded.

## Successful probe noise

Request history excludes successful 2xx GET probes by default, limited to exact
health/healthz and model-directory paths: `/health`, `/healthz`, `/v1/models`,
`/v1/models/claude` and `/v1beta/models`, with optional trailing slash/query. Model
details, files, Responses reads and other business GET requests remain ordinary
audit traffic. Errors and aborted probes retain safe diagnostics when capture is
enabled. Turning off all audit capture still stops capture, including failures.

`capture_successful_probes` explicitly enables successful-probe history. The HTTP
owner snapshots this setting, original start time and capture generation at entry.
Eligible probes defer database admission until outcome; a successful suppressed
probe creates no parent/body/drop record and its response passes through unchanged.
Failed probes retain their original audit start and cannot bypass a later clear
generation merely because admission was deferred. No historical records are removed
when changing this setting.

## Explicit clear and saved export

Traffic Monitor asks for confirmation before clearing a category and offers Cancel.
The scope is the entire category, including records hidden by date/search/session
filters. The receipt uses the owner's actual affected count. The view retains its
filters/page so automatic navigation does not discard that receipt. Pending clear
disables repeat submission in the control. A failure shows the localized uncertain
outcome and refreshes cached gateway data; another attempt requires confirmation.

An explicit clear advances a process-local capture generation for its selected class,
or every class for all-scope clear. While its Worker request is pending, new audit
admission in that scope is refused with `audit_clear_in_progress`; model execution
continues. Other classes remain active. Old handles, prepared payloads, serializers
and SSE writers stop admitting content. The serial Worker checks the generation of
queued parent/admin admissions, so a delayed pre-clear insert cannot recreate cleared
history. Missing parent/attempt body admissions become no-ops instead of recreating
owners or failing a foreign-key write. Clear deletes its parent/admin scope in one
transaction and advances Worker generation floors after commit. Counters/drop buckets,
archives, Thought Store and internal diagnostic files retain their separate owners.

A failed clear reports failure and does not claim a row count. Transaction failure
preserves rows and the Worker floor, while the service's capture boundary still ends
older affected captures. An unknown Worker reply can leave deletion uncertain; refresh
the list before retrying. Generations are not database schema or an unbounded ID map:
four counters and weak handle ownership live with the process. Worker replacement
does not replay failed queued messages, and the service still rejects stale producers.

Saved-body export reads one bounded page at a time and checks terminal metadata,
cursor progress and total stored bytes. It rejects missing, writing, expired or
changing bodies, including disappearance after the final yielded chunk. A final
metadata read establishes completion of the saved snapshot; no full body is buffered.
The existing native file owner atomically replaces the destination only after a
successful read. Failure retains the previous destination and removes partial output.
Complete empty captures and terminal partial prefixes remain valid exports of what
was actually saved. A snapshot fully read before later deletion can still be saved;
this does not restore any database record or promise original missing bytes.

## Monitor columns and session filters

Column widths use stable column IDs within each traffic category. Preferences accept
only finite numeric values and clamp them to 45–640 px. Every column supports pointer
and arrow-key resizing, with a visible reset action and accessible current/min/max
values. Pointer completion/cancellation, window blur, category change, reset and
unmount detach the owned drag listeners. Header and rows use the same computed width
and scroll position. A storage failure leaves the current layout usable and marks
the preference unsaved rather than throwing from a render updater.

The exact saved-session filter uses the complete stored `sessionId`, including its
tenant prefix. Apply/reset returns to the first page; the route and query-cache key
retain the same bounded value. Owner and Worker input boundaries reject empty or
over-512-character values. Queries compare equality with prepared bindings, so `%`
and `_` remain literal. System admin events without sessions are excluded when this
filter is present. Metadata substring search remains independent. This filter does
not create a session, merge suffixes, trust a response header or change authorization.
It is an additional admin history query, not a tenant authorization mechanism.

The optional filter requires an updated selected audit owner. Older strict owners
reject the unsupported input with the normal unavailable-history feedback; the
renderer does not retry an unfiltered query. Existing callers omitting it are
unchanged. Database schema, stored identities and detail/body export ownership stay
unchanged; a body is still exported by its selected saved body ID.

## Scoped session capture and export

New HTTP audit capture resolves the canonical D03 client hint and caller credential
scope. Protocol services publish their resolved audit identity after
verified Responses lineage restoration or generated-content anchoring. Completion
retains that identity on the parent; attempts/bodies keep their parent links.
Response session headers cannot overwrite it. Equivalent Bearer/API-key credentials
share scope; different credentials do not. An unverified `previous_response_id` is
never itself a stable session ID.

Older raw/unscoped values remain unchanged: redacted headers cannot establish a
safe backfill. New keys use the existing `session:affinity:v1:` or `session:store:v2:`
digest forms. These admin query keys are not authentication tokens. IPC records
retain their separate app-action identity and are outside model-session export.

The explicit export includes every retained model parent in the scoped key, its
attempts, descriptors and actual safe body content. Other list filters do not limit
it. Version-1 `agm-audit-session` NDJSON starts with session metadata, then request
detail and body start/chunk/end records, ending with an explicit completion record.
Shared body IDs are emitted once per parent; descriptor associations remain. No
current credentials are added. Partial capture stays partial; missing/expired bodies
cannot become successful empty exports.

The Worker fingerprints settled metadata before and after export. Active records,
membership/metadata changes, missing bodies and limits fail rather than omit data.
Snapshot admission allows at most 2,000 model parents, 256 attempts/1,024 payloads
per parent, 128 Ki characters per metadata group and one second of synchronous
snapshot work. The file owner caps the complete escaped stream at 100 MiB. Failed
reads remove temporary output and preserve the prior destination. A lost final RPC
acknowledgement leaves completion unconfirmed: check the destination before retrying.
No read transaction survives across file writes, and export never recreates history.

Main owns the native chooser and captures the selected file owner before it yields.
The renderer supplies only a scoped key and suggested name, never a filesystem path.
Cancel does not invoke export. Older standalone cores without the new operation fail
normally, with no local-store fallback.

## Viewer navigation

The bounded CodeMirror window offers wrapping or horizontal scrolling. Preference
failure keeps the view usable with unsaved feedback. Search returns up to 100
matches; previous/next reaches all returned matches although only 20 snippets are
listed. Failed jumps do not advance selection. Cancel ignores late replies without
claiming the dispatched Worker scan was interrupted. Paging, UTF-8 limits and raw
business-string semantics remain unchanged.

## Audit payload lifecycle

Chunks are appended only while a payload is `writing`. Completion also requires that
state. Late appends, duplicate completion and completion after retention do not modify
a terminal payload. This includes worker-side SSE reconstruction. Expired body metadata
keeps its retention reason and empty chunk list; late producer commands cannot recreate it.

Identical completed payloads still deduplicate within one parent request. Body paging,
search and export retain their raw UTF-8 chunk representation and existing schema.

## Restart reconciliation

The audit owner passes its process start timestamp to each Worker, including
same-process replacements. At open, a single transaction closes only unfinished
captures whose start predates that boundary. It marks parent/attempt capture end
and response-partial metadata, preserves the stored `in_progress` outcome and
leaves provider status, usage, errors and duration unchanged. Reads derive
`capture_interrupted` from `in_progress` with a recorded capture end. The end time
is reconciliation time, not an inferred model completion time. Usage aggregation
continues excluding unknown model outcomes.

Old writing bodies become incomplete with the existing restart reason and the
actual chunk byte/count totals. Stored chunks are preserved. Completed neighbors
are unchanged and repeated opening is idempotent. A current-process writing body
or request remains active across Worker replacement and can continue. This is a
process-boundary check, not an inactivity timeout, and uses the owner's existing
internally recorded wall-clock timestamps.

Recovered captures become eligible for normal whole-parent capacity reclamation.
An attempt with a reconciled capture-end marker no longer pins its parent forever;
an active attempt or writing body still protects it. Failed reconciliation rolls
back parent, attempt and body metadata together, closes the connection and fails
Worker initialization. No model request is replayed. Same-process failures that
lose a completion command remain unknown until the owner process ends or the user
explicitly deletes the record; no guessed TTL or model failure is invented.

## Live and archived storage

Statistics report live DB/WAL/SHM usage separately from preserved schema/corruption
backup files. Archive measurement scans at most 4,096 entries in the database's
own directory and recognizes only its exact schema-version/timestamp or
corruption/timestamp backup naming convention, including archived WAL/SHM files.
The count is files, not complete database snapshots. Unrelated stores and arbitrary
backup names are excluded. Measurement reads metadata, never opens archived
contents, follows a matching link or deletes archives. A matching non-file,
inaccessible/disappearing file or exhausted scan budget reports archive usage
unknown; it does not imply zero bytes. Failed live measurement remains a stats
error and the UI offers retry rather than showing a fabricated zero total.

Archives are outside the configured live audit budget and automatic capacity
eviction. They remain available for the existing manual recovery procedure; no
archive deletion or automatic restoration is added. Both settings and Traffic
Monitor label live/archive totals, and expose only numeric totals/status over the
typed stats boundary. Owner compatibility `5` prevents a desktop/core contract
mismatch; see the [upgrade guide](../../upgrade-guides/next/audit-storage-budget.md).

## Capture feedback in Traffic Monitor

Body details distinguish missing capture metadata, active capture, complete or empty
capture, binary summaries, partial/oversized capture and historical expiration.
Missing metadata does not establish that capture was disabled. Known storage/capture
reasons have localized explanations; unknown persisted reason text is not echoed.
Saved and observed bytes are separate, as are full-representation, saved-prefix and
unavailable hash coverage. These describe the safe captured representation, not
original credential-bearing bytes.

The viewer uses current page metadata to report expiration or disappearance while
reading. It clears the obsolete window rather than calling a missing page a completed
read. A read error retains successful pages and their cursor, stops automatic retry
and offers an explicit retry. Pausing loading invalidates late results; it does not
cancel an already dispatched IPC operation. Selecting another body also discards old
results. A writing capture can be refreshed explicitly without polling the full body.
Search jumps reveal the bounded raw page containing a match, including matches
beyond the initial preview, rather than applying that preview to the selected page.

Copy exports exactly the displayed view/window to the clipboard, including formatting
or the preview marker. File export stays in the existing native owner and exports
saved content, which can be partial; it cannot recreate omitted bytes. Export is
disabled while capture is writing. Failed copy/save has explicit retryable feedback;
a cancelled native save is not reported as successful. Selecting an attempt without
captured content does not fall back to another attempt's body, and body buttons show
their attempt number. Existing preview/page/window budgets and safe export ownership
remain in place.

An append refused by storage admission keeps its actual stored prefix and becomes
`incomplete`, with the closed storage reason and a `stored_prefix` hash scope. Late
completion cannot turn that terminal prefix into a complete payload. If even the
small failure-metadata update cannot commit, the original rejection is reported and
the existing writing/restart-recovery state remains; successful failure metadata is
not assumed. The safe worker error adds `capture_metadata_unpersisted`, retaining
the original storage reason so logs report the incomplete recovery. SSE reconstruction reserves its replacement before deleting raw chunks.
A denied reconstruction retains redacted raw SSE, identifies the capacity reason and
does not label it as a parse failure.

## Write admission

The audit service attaches the configured byte budget to each write command. Worker
envelope validation rejects invalid budgets. The serial repository measures the DB,
WAL and SHM before each growing write and completion update, then reserves conservative
database/WAL/index and transaction-frame overhead. Growing writes leave additional
room for completion metadata. Queue acceptance reserves bounded memory, not a future
disk allocation: each command checks again after preceding commits or failures. No
SQLite transaction or disk reservation is held across an asynchronous yield.

If the projected write does not fit, admission attempts one checkpoint with a zero
busy timeout and at most 128 incremental-vacuum pages, then remeasures. It restores
the connection's normal timeout. Admission does not evict history or retry writes to
make room. Pinned readers and insufficient reclaimed space refuse the write. Only
missing WAL/SHM files count as zero; a missing main database or another stat error
means capacity is unknown. Stats propagate that measurement failure instead of
reporting zero usage. Read-only and full-disk SQLite failures retain closed storage
identities and their original internal causes.

Storage refusal is detached from model execution. Existing query, export, deletion
and shutdown paths remain available. The service retains the reason in drop statistics
even when the drop record itself cannot be persisted. Settled asynchronous chunk
failures remain part of final capture accounting after they leave the in-flight set.
Disabling capture stops new body/chunk admission, including existing SSE writers;
already accepted writes and bounded completion metadata keep their lifecycle.

This is conservative write admission, not an operating-system disk quota. File sizes
can already exceed a newly reduced budget, and SQLite allocation is estimated before
commit. Existing databases are retained and maintenance remains responsible for its
bounded reclamation policy. This implementation changes neither SQLite dependencies
nor the database schema or schema-opening policy. See the
[upgrade guide](../../upgrade-guides/next/audit-storage-budget.md) for operational effects.

## Capacity window and configuration migration

New or missing audit settings default to 1024 MiB and 100,000 parent requests.
Existing explicit capacities are retained. Audit history no longer expires by age;
previously expired content remains unavailable. The obsolete body-hour and summary-day
controls are removed from configuration, Worker messages and settings. Thought Store
retention remains independent. Longer audit retention still respects capture limits,
capacity and explicit deletion; it does not promise complete or indefinite capture.

Loading configuration converts only the in-memory view. Before the first save that
removes age fields, the config owner atomically preserves the exact original file as
`gui_config.json.pre-audit-window-migration.bak`. An existing valid recovery copy is
kept. A failed or invalid backup blocks that save. Failed replacement preserves the
previous configuration and cached snapshot; a subsequent save can retry. This backup
is local sensitive configuration, excluded from diagnostic exports. See the
[upgrade guide](../../upgrade-guides/next/audit-storage-budget.md) for restoration.

## Retention and disk reclamation

Maintenance captures request row-ID and time bounds, including completion time.
Requests still running at capture, active attempts and writing payloads are protected.
Non-stream response capture establishes body ownership before marking its parent or
attempt complete. Eligible parents are removed in global timestamp/row-ID order,
independent of traffic class. Foreign-key cascades delete their attempts, references,
payloads and chunks together, including parent-local deduplicated bodies.

Row pressure returns only to the configured parent cap. Administrative events have
a separate 1,000-record window and drop buckets a 128-entry window, both counted in
physical storage. Drop totals describe retained buckets rather than lifetime totals.
List/stats record counts still include administrative events; they are not the parent
limit. Requests may have multiple attempts, which consume the same disk budget.

Row batches remove at most 32 parents and stop at a 20 ms soft budget between
parents. Auxiliary batches have at most 32 entries. Each batch yields to the weighted
Worker queue without an open transaction or iterator. Captured bounds protect new
arrivals even after clear reuses row IDs. Concurrent user deletes reduce the remaining
target; new auxiliary arrivals cannot extend the captured cleanup workload.

Disk pressure first reclaims available free pages. If the initial measurement exceeds
the budget, it targets 70% of that budget, deleting one eligible whole parent before
each physical remeasurement. Checkpoints use a temporary zero busy timeout, restored
afterwards. A pinned reader, stalled vacuum or lack of physical progress stops further
disk deletion. Row-cap deletion is independent of checkpoint contention.

Incremental vacuum captures its free-page workload and yields in steps of at most
128 pages. Pending free pages request the existing coalesced one-second continuation;
a busy reader alone does not. Startup, the hourly interval and serial configuration
passes also maintain the window. Failure logs without an immediate retry. Shutdown
cancels timers and replacement workers discard the prior scheduler generation.

When storage remains above budget, the Worker emits numerical usage, budget,
checkpoint contention and pending-vacuum fields without body, account or credential
data. The budget is admission plus a maintenance target, not a hard filesystem quota.
Active data, a minimal SQLite layout or blocked reclamation can prevent reaching it.
There is no wall-clock guarantee for one large cascade or an entire pass; shutdown
retains its drain deadline and reports incomplete drain.

## Reasoning history management

The protocol SignatureStore bounds its combined hot message, legacy and tool-ID
associations to 10,000, including ambiguity markers. Its separate 500-session LRU
remains active. New captures evict the oldest captured association when capacity is
exceeded; reading a slot does not move its capture age. Each alias counts separately.
Rewind and scoped deletion release their actual slots without a permanent alias log.

These mapper cache values lack proven provider-completion metadata and keep a fixed
one-hour maximum from first capture. Reads, equivalent stores and conflicting null
markers do not renew that maximum. A genuinely later capture after expiry can create
a fresh association. This cache horizon does not extend the durable seven-day tool
reference policy or assign completion metadata to legacy records. Cache eviction is
a miss and does not delete independent Thought diagnostic records or replay work.

New explicit client scopes use the D03 hint resolver and normalized caller digest.
Their `thought:client:v2` keys preserve distinct Unicode, case and punctuation
without storing credentials or raw hints. An unverified previous-response cursor
is not a session ID. A hint-free request can bind to a protocol-proven scope or
caller-owned Responses history before asynchronous media restoration. That binding
is fixed for the request; downstream conversion does not replace it. Older keys
remain diagnostic and are not heuristically assigned to new scopes.

Explicit delete/clear revokes the affected request leases and drains accepted
Thought writes before SQLite deletion. After confirmed SQLite deletion, the two
registered recovery owners remove exact captured associations. Signature-cache
counts measure slots/tool associations. Responses counts measure retained durable
history entries and live connection transcripts. These counts are not Thought
records and are not summed across owners. Newly captured Responses ownership
survives JSON restart; unknown legacy ownership remains unknown on scoped deletion.

The additive `recoveryComplete`/`recovery` receipt identifies complete, partial,
failed or unavailable owners. HTTP exposes `recovery_complete` and `recovery` while
retaining its existing session/record units. The diagnostic panel retains confirmed
SQLite counts and warns when peer cleanup is unconfirmed. A missing owner is
unavailable rather than confirmed zero. The selected process composes one lazy
Responses metadata owner before the gateway starts. Nest reuses that same instance
across stop/start; only its private-media facade follows the gateway FilesService
lifetime. Registration performs no profile I/O. A clear while the gateway is stopped
uses this same owner, including its first lazy open, without a second file writer
or local-store fallback. Terminal diagnostic shutdown closes admission, disposes
media and strictly flushes that owner's admitted metadata writes.

SQLite and Responses JSON do not commit atomically. A strict JSON replacement
failure can leave SQLite deleted and live caches revoked while old Responses rows
remain on disk. There is no automatic destructive retry or rollback claim. Inspect
the receipt and refresh history before a deliberate retry. A subsequent ordinary
Responses write can persist the current in-memory state through its existing owner.
End archives Thought rows; maintenance, close and repair do not request persistent
peer deletion.

Each active WebSocket transport registers its current transcript until closure.
Only executing frames hold request leases. Scoped deletion forgets the matching
transcript and prevents pending validation or late completion from reinstalling it;
other connections remain intact. Changing an explicit client scope starts a new
transcript. A cleared connection requires a fresh create request. Previously
delivered client content and private media files retain their separate ownership
and retention rules.

New complete physical replies carry an operation ID, a canonical causal-history
candidate and their original completion time. Two identical replies from separate
invocations remain separate. The canonical prefix includes complete ordered business
text, tool arguments/results and media/reference fields, excluding reasoning and
signature fields that restoration supplies. It hashes framed values without making
another complete serialized request. A causal match is a candidate, not proof that
two physical invocations are one operation.

Streams stage at most 2,000 parts and an estimated 64 MiB per capture, with a shared
256 MiB retained-capture budget. Only successful upstream end with STOP and actual
output commits one complete record. Consumer close, upstream failure, invalid data,
revocation or budget refusal discards the staging buffer; generation/audit transport
retains its separate outcome. Raw validated parts supply reasoning, independently of
audit redaction. Oversized captures increment persistence failure rather than
changing the model response. Estimates are not RSS or a hard transient-allocation cap.

Older recovery queries scoped causal indexes, at most 64 anchors, 64 candidates per
anchor and 256 candidates/64 MiB per request. Overflow fails instead of truncating a
candidate set into false uniqueness. Only complete, model-compatible records with
known operation and completion provenance enter that point-query result. Final D04
signature and complete tool-identity checks still apply; ambiguous retries miss.
Queries use the existing cold-load queue and requester cancellation. Point-read
bodies serve that request without installing an enlarged L1 cache. Failed lookup
continues without older restoration and does not replay generation or tools.
Ordinary lookup faults use a one-second monotonic cooldown in the bounded memory
session; queue admission failures retain their separate counter and a later request
can recover. No unbounded per-session failure registry is added.

Durable tool associations reference a record/part, without another copy of the
signature or reasoning body. Their original physical completion controls seven-day
read expiry; the reference table retains at most 10,000 links. History enrichment
and replay never renew completion or move the reference's eviction order. Expired
or capacity-evicted links lose automatic tool-signature recovery while the diagnostic
entity retains its stored content. Counts report currently unexpired durable links;
the retained L1 and older legacy matching remain separate owners, not proof of a
global whole-process association cap. Recent loads and older candidates apply a
single bounded, session-scoped tool permission query. Warm replay refreshes those
permissions before restoring tools, including capacity eviction and seven-day expiry.
The reply contains at most 10,256 operation entries and 10,000 positions, without
thought bodies. Unavailable permission reads deny durable tool restoration for that
request, report the existing read/admission failure and use the existing one-second
read-failure cooldown. Unacknowledged memory captures keep their finite fallback;
successful write acknowledgement or hydration makes durable permissions authoritative.
Late replies cannot cross scoped deletion, cancellation or terminal generations.
Management detail reads retain diagnostic signatures. Legacy records retain the prior D04 matching
limits for signed thought content. Legacy/history/partial records without proven
complete-operation provenance cannot automatically restore tool signatures: their
original tool-link expiry is unknown. No completion time or durable tool link is
invented or backfilled. Same-round enrichment preserves the permissions of live
tools across layout changes; replay never recreates a previously signed association
after capacity eviction, even when later maintenance frees space.

Schema 3 adds nullable operation/causal/completion provenance and the reference
table/indexes. Schema-2 rows, blobs and timestamps survive one transactional additive
upgrade, with old provenance remaining unknown. Failure rolls back schema, rows and
version. The explicit replacement policy for schema 0/1 still applies. See the
[upgrade and recovery guide](../../upgrade-guides/next/thought-history-read-budgets.md).

The selected desktop/core Thought owner returns version-1 metadata pages, rather
than a complete summary array. The first request uses `afterId: 0`; the owner captures
`throughId`, the highest record ID in that session. Continue with the returned
`nextCursor` and the same `throughId`. Each page has at most 200 summaries (desktop:
50), a 512 KiB serialized limit and explicit `complete`. Stored metadata sizes are
checked before materialization. Replies must progress beyond the requested cursor
and retain its high-water ID. Later appends lie outside that traversal. Concurrent
deletion can remove rows between pages; this is not a transaction held across reads.

The authenticated HTTP metadata route is
`GET /v1/thinking/sessions/:sessionId/records?after_id=0&limit=50`. Follow-up requests
also supply `through_id`. The session key is resolved from the caller credential
scope. Existing complete-session HTTP reads retain their explicit count/byte refusal;
they never silently return the first page as complete history. Individual body reads
still use the existing bounded record/content owner.

Delete, clear and end count durable sessions and records in the same SQLite
transaction as their mutation. End archives the session and retains its records;
delete/clear remove them. The private receipt is `{ sessions, records }`. Existing
admin HTTP `affected` remains a session count and gains `records`; the external
delete/end response retains its boolean/session ID and explicitly names
`records_deleted` or `records_retained`. Counts never come from the L1 cache.
A failed transaction produces no success receipt and retains its rows.

The diagnostic panel provides record paging, loading/empty/error states and deliberate
retry, with separate detail failure/missing-record feedback. Deletion confirmation
names the selected scope and supports cancellation. Success reports both units;
failure refreshes history, names the unconfirmed outcome and requires a fresh
confirmation before another mutation. No destructive retry is automatic.

## Thought compression and corruption

Thought text uses the existing `RAW1`/`AGZ1` codec. Text of at least 384 UTF-8 bytes is
compressed using fast gzip only when the encoded result is smaller. Small or incompressible
text remains raw. Logical retention limits continue to use uncompressed UTF-8 bytes;
compression does not enlarge the permitted session or turn limits. Legacy unprefixed text
remains readable. Audit chunks do not adopt this thought-record codec.

Invalid gzip data rejects a body-bearing read with its numerical record ID and the decoder
reason. Metadata listing and the worker remain available, and the damaged bytes stay in
SQLite for diagnosis. The store does not replace corrupt data with a successful empty thought
or automatically repair it. A generation-time hydration failure follows the service's existing
policy: warn, retain the incoming model request and continue with any locally captured records
available for that session, without retrying the failed request. Explicit management body reads propagate the error.

Decoded thought text is limited to 64 MiB and to the stored logical byte count;
gzip uses `maxOutputLength` before expansion. Raw and legacy blobs use the same
ceiling. Metadata selection measures stored UTF-8/blob lengths before returning
contents to JavaScript. JSON metadata fields are limited to 16 MiB, complete reads
to 10,000 records and retained/serialized Worker replies to 100 MiB. This separate
reply budget preserves the existing 64 MiB text capability and large per-part
signature transfers. Worker messages use structured data rather than JSON escaping;
control characters are not charged as six-character JSON sequences. Serialization
still creates a bounded temporary buffer and does not prove a process RSS ceiling.

Complete management reads reject over-budget results instead of silently returning
a truncated complete session. Recent cold windows can remain smaller by contract.
History matching also preflights its bounded candidate metadata. Invalid/oversized
rows stay stored; reads do not repair or delete them. A failed body read does not
refresh durable idle time. Selected-record and metadata neighbors remain available
when they fit their own budgets. See the [read-budget guide](../../upgrade-guides/next/thought-history-read-budgets.md).

## Cold restoration and memory

The L1 cache defaults to 600 turns, configurable from 10 to 10,000. Its per-session
64 MiB maximum includes thought/signature/visible/tool/fingerprint metadata; the
separate global 256 MiB retained-cache accounting remains active. Neither limit is
a process RSS ceiling. Evicting L1 no longer deletes durable records. A single
persisted record still has a 64 MiB thought/signature ceiling, independently of a
smaller configured L1 cache. Durable defaults remain 15 idle days / 2,000 sessions,
with a separate 1,024 MiB disk budget including DB/WAL/SHM and per-write reservation.

Old explicit 200-turn settings stay 200. Missing values default to 600; old 1–9
settings load as 10 with a fixed warning. Before the next save, the configuration
owner preserves exact original bytes in `.pre-thought-window-migration.bak`. Invalid
backups block saving. This configuration copy is private and does not reverse the
separately authorized schema-0/1 Thought Store replacement.

Both features use the shared serial SQLite reservation/reclaim primitive; their
deletion policy and closed failure reporting remain feature-owned. Diagnostic queue
acceptance reserves memory, never a future durable allocation. Thought writes reject
unknown disk usage, insufficient budget, readonly storage or failed reclaim; old
queries remain available. A full persistent session window refuses a new session
until bounded idle maintenance makes room. Accepted failures are counted and shown,
without replaying model/tool work or claiming the memory copy was committed.

Thought Store maintenance inspects at most 64 candidate sessions and deletes at most
128 records per pass, with an 8 MiB stored-byte work budget and a 25 ms loop deadline.
One record up to 100 MiB may make progress alone; this is an explicit exception to
the ordinary byte budget, not an interruption guarantee inside SQLite. Empty session
rows are removed after their final record. Remaining work
continues after one second through the same coalescing scheduler as audit maintenance.
The existing hourly check remains; opening the Thought Store alone does not start cleanup.
Configuration applies a bounded pass and can start continuation. Explicit session deletion
and clearing the store retain their complete-operation behavior. These session batch limits
do not guarantee a hard wall-clock deadline or an OS memory bound. Count/disk pressure
protect sessions accessed within five minutes; age expiry retains its own cutoff.
Checkpoint contention pauses deletion. A non-shrinking file stops further pressure
deletion across maintenance calls in the current Worker until measured usage falls
or the budget is raised. Reopen resets that process-local no-progress latch. New
databases enable incremental vacuum; old databases are not converted with full VACUUM.
Maintenance publishes affected session keys so their L1 and pending hydration are
invalidated before the service acknowledges the pass.

Maintenance also excludes the complete active-request key snapshot supplied with the
pass, including sessions older than the five-minute grace or age cutoff. If more than
2,000 active keys prevent a complete snapshot, that pass defers with `active_sessions`.
The snapshot is taken at admission; it does not retroactively protect a request that
starts after the pass. Protected-only history does not schedule one-second cleanup loops.

HTTP and typed IPC request contexts own capture leases until completion or disconnect.
Gemini stream callbacks retain their original lease. End/delete revoke that session;
clear, close, repair and shutdown revoke every session. A scoped mutation first stops
new capture admission and invalidates L1, pending hydration and retained content
handles, waits up to five seconds for the finite snapshot of accepted Worker commands,
then issues its durable operation. Other sessions continue. Overlapping mutations are
serialized; a failed drain prevents the durable command. Failures leave old captures
and handles revoked without claiming that rows were deleted. Fresh requests after the
mutation can capture again; requests begun while blocked continue without cache writes.
Hydration invalidation uses request-owned leases rather than permanent session tombstones.

The HTTP body hint is resolved during pre-handler processing. Before that point only
the entry identity is known; global invalidation still revokes that request. This
lifecycle applies to the HTTP/IPC contexts that own it, not unrelated WebSocket state.
Content invalidation also rejects a record reply already being read before invalidation,
so a late result cannot open a new old-content handle. A neighboring session remains valid.

Generation-time cold loads select a contiguous recent suffix using record metadata before
fetching or decompressing thought bodies. The active turn count and uncompressed thought-byte
budget limit that suffix, including visible/tool/metadata content; if the newest record exceeds
the budget, no older prefix is restored. Explicit management reads expose a complete durable
session within their finite count/byte budgets. Cold filtering
does not delete durable rows or hide their corruption from explicit body reads.

The first capture after restart leaves the session eligible for durable hydration. Concurrent
requests for one session share its pending load. Hydration merges responses captured while the
read was pending, retaining the stronger thought body and the latest available signature.
Failed hydration also applies cache eviction and retains captures. Ordinary read failures keep
the session unloaded with a one-second monotonic cooldown. A later independent request can
read again after that cooldown; no failed model request or tool is automatically replayed.

Different-session cold loads use a Thought Store-owned FIFO admission queue before the SQLite
worker. It allows one executing cold load and at most 64 waiting loads. A waiting load expires
after five seconds without issuing its read. Between loads, the service yields to restoration
and other event-loop work. Same-session requests continue to share one hydration. The shared
worker's control lane policy is unchanged; cold commands no longer consume its full count
budget during a distinct-session burst. Management operations still have the worker's normal
capacity and can wait for an executing large read.

Capacity and waiting-time failures log a fixed admission reason and increment the separate
hydration-admission failure count. Actual read failures and persistence failures have separate
`readFailures` and `writeFailures` counters. They preserve locally captured history and continue the incoming request. An
unissued failed load does not mark the session durably loaded, so a later independent request
can request hydration; the failed load is not automatically retried. Admission refusal does
not receive the ordinary read-failure cooldown.

Terminal shutdown, reusable close and repair cancel unissued waiting loads. An executing read
settles under the worker's existing lifecycle policy. Generation checks prevent old replies
from repopulating the cache or restoring output after a close/reopen. Reusable close coalesces
concurrent callers and rejects management work while closing. Revoked request captures
cannot start a replacement writer; fresh requests can capture after close completes.

Each generation requester can cancel its own hydration subscription. One cancelled subscriber
does not cancel another requester of the same session. The final subscriber cancels unissued
work and detaches from an executing read; an executing SQLite command still owns the cold-load
slot until its actual reply settles. Cancelled requesters do not restore or ingest history,
and their cancellation does not count as a persistence failure. A later requester can load
the same session without inheriting a cancelled job.

Internal generation checks cancellation before restoration and carries the signal through
its requester subscription. It also detaches the full request from pending explicit-context
cache creation. Shared cache creation retains only its separately owned static candidate
and existing bounded upstream timeout; cancelling one requester does not cancel that shared
resource. Anthropic Messages forwards disconnect signals through account selection, generation
and first-event preparation. Cancellation exits recovery/account-rotation paths without
marking a successful generation or applying an upstream failure penalty.
The stream returned by the internal client owns its original upstream source. Destroying
the captured stream unpipes and destroys that source, releasing the HTTP connection rather
than leaving a paused source alive after downstream unsubscribe.

The memory cache has an independent 256 MiB estimated retained-size budget as well as the
configured session-count limit. It accounts for all retained strings in UTF-16 plus fixed
entry/record overhead, including visible text and signatures. Least recently accessed cache
entries are evicted without deleting SQLite history. A request can restore from its loaded
records even when they cannot remain in the cache. Later requests reload evicted history.

This cache estimate is not a hard heap or RSS limit. In-flight worker replies, gzip output,
cross-thread copies, model request construction, SQLite and garbage awaiting collection use
additional memory. The cold admission queue does not bound caller-owned restored request
bodies, completed replies awaiting GC, or full management reads. Cache eviction cannot recover captures whose persistence was rejected;
diagnostic write failures continue to be counted.

## SSE output pressure and shadow framing

The actual Readable-backed Gemini, OpenAI Chat, Responses and Anthropic adapters return a
flow-capable Observable. The writer pauses that Readable when a socket write returns false
and resumes it only after pending output drains. The Anthropic preflight wrapper preserves
this capability and does not override a downstream pause when transferring buffered events.
The HTTP Responses session wrapper also preserves the underlying pause/resume owner.
The external Observable response type and SSE event content/order remain unchanged.

An output pump retains complete emitted strings while sending slices of at most 16,384 UTF-16
code units without splitting a surrogate pair. Each socket slice is copied to a small Buffer
so pending socket writes do not retain the full parent event string. Large events can cross
many drain cycles. Completion and error framing wait for earlier output to drain.

The pump charges two bytes per retained code unit plus 64 bytes per frame, until the whole
frame is written and its blocked final write drains. Its estimated retention limits are
128 MiB per stream and 256 MiB shared with Responses WebSocket output in the process. The current input
chunk in Chat, Gemini or Anthropic can emit several mapped frames after pause; that residual
work still uses these budgets. Responses pauses its mapping iterator between individual frames.
A drain that does not arrive within 30 seconds, budget overflow or a write failure records
partial failure, unsubscribes and closes the socket without a success marker or automatic
retry. Close releases all credits and removes drain listeners.

Synthetic Chat and Responses fallbacks use a single-consumer frame iterator without lookahead.
Responses mapper operations, including text/reasoning/tool closure and complete/incomplete/failed
termination, serialize one frame per iterator advance. HTTP drain and WebSocket send completion
resume that iterator before resuming the upstream Readable. One mapping operation is drained or
closed before another starts. The adapter releases its decoded event scope before generating
queued finalization frames. Cancellation closes pending iterators, detaches adapter listeners
and destroys the upstream; a pre-subscription cancellation also prevents synthetic factory work.
The existing usage, tools and terminal event sequence remain unchanged. Required full-text
terminal fields are still serialized separately, and unary fallback bodies already exist in memory.

Other Observable producers retain the 16 MiB pending socket
plus incoming UTF-8 chunk guard. A single larger chunk fails on that path even with an empty
socket. These producers do not claim Readable pause/resume capability. Numeric diagnostics
remain available and normal cumulative output can exceed the limit while it drains. Applying
an RxJS operator that returns a plain Observable also removes the explicit flow capability.

These are retention estimates, not aggregate heap/RSS limits. Upstream parser/mapper state,
caller-owned bodies, audit shadows, native/kernel buffers and garbage awaiting collection
are outside the output pump; plain-Observable socket buffers are outside its global budget.

### Responses WebSocket pressure

The WebSocket transport sends each Responses event as one complete JSON text message. It
pauses a flow-capable upstream until the `ws.send` callback returns, sends queued messages
in order and waits for pending messages before admitting the next generation. The callback
confirms local sending, not client processing. A slow receiver can accept several messages
into native/kernel buffers before a send stalls.

The live and synthetic Responses mapper producers expose their current serialized JSON
alongside the SSE frame during synchronous delivery. WebSocket consumes that canonical frame
without assembling SSE data, parsing JSON or serializing the event again. Completed-response
history uses the mapper's completed output items. Only one current frame is retained, and
producer completion or cancellation clears it. Observable wrappers and other sources do not
inherit this capability; their events still cross the existing JSON validation and normalization
boundary. Each queued message owns one UTF-8 Buffer, reused by `ws.send` as a text message.

WebSocket output reservations include two bytes per UTF-16 code unit, the UTF-8 encoded
message length and 64 bytes per frame. Each flow-capable connection has a 128 MiB estimate;
plain Observable output has 16 MiB. Both share the HTTP pump's 256 MiB process-wide output
budget. The estimate remains conservative because a paused producer can retain its UTF-16
frame while the queue and `ws` share the encoded payload. A send error, budget overflow or a
callback stalled for 30 seconds terminates the
connection, unsubscribes upstream and releases its reservations. Late callbacks do not
release already cleared credits again. There is no automatic retry or success frame.

The incoming frame limit is the existing 64 MiB model JSON body limit. A connection admits
at most 16 active/waiting requests and 128 MiB of their raw message bytes. Exceeding either
queue limit terminates that connection before issuing its queued generations. These are
per-connection bounds, not a global ingress-memory cap. Disconnect aborts the active request,
detaches admission waiting and destroys a late unconsumed flow-capable result. Plain custom
Observable producers continue to own any resources allocated before subscription.

Closing or terminating a connection clears its protocol request, completed output, response
ID, pending tool IDs and repair cache immediately, even if a late operation retains the
closed connection context. Active connections retain their current complete transcript and
tool repair history; output reservations and incoming queue limits do not bound that history
or its aggregate size across connections. Transcript assembly copies arrays of item references,
without cloning their complete text strings.

A completed output is pending transcript input until the next request passes preflight.
That request merges the output once, or discards it when the client compacts/replaces the
transcript, then clears the pending-output reference. A rejected preflight preserves it.
A generation failure after admission does not restore the old output on another append.
Tool repair queries the socket's existing call-ID index directly instead of copying and
rebuilding the complete tool cache for every request. Historical calls remain available for
late orphan results, including after compaction; this index is not an eviction policy.

### Large-event decoding

Gemini observation, Chat, Responses and Anthropic streaming adapters scan new decoded
fragments once and join an unfinished SSE line only when its newline arrives. The estimated
unfinished-line budget is 128 MiB, charging two bytes per code unit and 64 bytes per nonempty
fragment. Oversize input terminates with the owning protocol's error/failed frame and releases
the upstream. No successful terminal marker is emitted. WebSocket decoding uses the same line
reader and an additional 128 MiB estimate for a multiline event before JSON parsing.

These per-decoder limits do not cover input chunks already allocated by callers, the join
and JSON parse peak, simultaneous decoder instances or complete mapper history. Responses
finalization produces one serialized frame at a time, but each full-text frame and each JSON
parse/stringify operation can still allocate large transient strings. Other streaming adapters
can construct multiple mapped events after downstream pause and exceed the output budget.
The limits do not establish an aggregate RSS ceiling.

### Unary stream aggregation

The shared Gemini fallback collector uses the same incremental line reader and unfinished-line
budget. It preserves the existing first-candidate part order, final finish reason and latest
usage metadata, without repeatedly splitting an incomplete line. Malformed data and nested
fields retain the fallback's existing recovery policy; unterminated trailing data is discarded.
Oversized lines, an upstream error, premature close or idle timeout reject collection, destroy
the upstream and release partial parts and decoding fragments. Empty input rejects as before.
Completion transfers the assembled part array to the caller; every terminal path removes
only the collector's own listeners and clears its timer.

Collection pauses its upstream while owning one input Buffer and decodes it in windows of
at most 64 KiB. It yields through `setImmediate` after 32 lines, 64 KiB of decoded input or
approximately four milliseconds of work, including work across successive small chunks.
Normal end/close waits for pending input to finish; cancellation, errors and idle timeout
cancel scheduled work and clear the window iterator, input Buffer and unfinished line.
Admission remains held until this pending collection settles. A source that emits another
chunk despite pause fails rather than overwriting input or creating a collector-side queue.

These are cooperative checkpoints, not a hard event-loop deadline. Joining one complete
line, parsing its JSON and estimating the decoded tree still run synchronously between
checkpoints. A large single event can delay cancellation. Upstream prefetch and an already
allocated large Buffer are outside the decode-window bound; paused input keeps the whole
Buffer alive until consumed or cancelled. Window fragments also count toward the existing
unfinished-line estimate, so their overhead can make the line budget reject earlier.

Completed upstream objects therefore no longer retain a second ownership path to response
parts through collector callbacks. Collection still retains all accepted parts until unary
completion, and the caller then owns the complete response. The line budget does not limit
the aggregate part count/bytes, simultaneous collectors, an incoming chunk allocated by the
caller or the transient join/JSON parse allocation. No automatic truncation or compaction is
performed.

Multiple collectors can retain unfinished lines and completed responses concurrently. Node's
JSON parsing is synchronous on the gateway thread, but interleaved source delivery and caller
ownership still accumulate fragments, buffers and accepted parts across collectors.

The incomplete-unary-response fallback has process-wide FIFO admission: at most two active
stream starts/collectors and eight waiting operations, with a 30-second waiting deadline.
Admission precedes the fallback upstream call; ordinary complete unary responses do not take
a credit. Queue overflow or timeout returns local HTTP 503, bypasses provider account penalties
and retry, and releases any image permit. Request cancellation removes the waiter immediately.
Request aborts also bypass account failure recording and retry; provider cancellation is
normalized against the owning request signal before it leaves the generation helper.
The queue stores callbacks and cancellation metadata, not a body/token copy; the suspended
caller still owns its request while waiting. The discarded incomplete direct response leaves
scope before admission.

An admitted caller races its upstream start against cancellation. If that operation ignores
cancellation, its credit remains held until it resolves or rejects; a late returned stream is
destroyed. Once collection starts, the collector itself observes the request signal and clears
partial state even if the provider does not. Every settled collection releases its credit.
The existing active-stream idle timeout remains separate from the queue deadline.

These are operation-count and time bounds, not a shared byte budget or RSS ceiling. Waiting
requests can contain large inputs; two active collectors can still accumulate many parts.
Completed responses transfer to callers outside this admission lifetime. A provider start
that never settles can hold a credit indefinitely, so later waiters fail at their deadline
rather than creating additional hidden work. There is no automatic retry or truncation.

The fallback maintains a process-local numeric byte ledger, available through the admission
owner's `byteSnapshot`. Its categories cover waiting request bodies, active request bodies,
unfinished lines, accepted parts, latest usage/finish metadata and input/decode temporaries.
The snapshot also contains the current sum and a lifetime high-water estimate. Count snapshots
remain separate. Request estimates include the complete translated envelope, tool arguments,
signatures and inline media strings; credentials and headers outside that envelope are excluded.
Complete direct unary generation does not enter this ledger.

Estimation traverses own JSON fields iteratively and charges UTF-16 string length, object and
reference overhead without JSON serialization, base64 decoding or another text copy. Object
identity is deduplicated for translated requests; iterator state follows depth and weak identity
membership scales with visited objects. Unmodified trees from `JSON.parse` without a reviver
cannot contain aliases or cycles, so collection estimates them without an identity set.
Scalar fields are counted inside their owner frame; only child objects produce traversal
frames/results. Part charges are calculated at acceptance rather than rescanning accumulated
history; the current decoded response is also walked for its separate transient estimate.
Latest metadata replaces its prior charge. Decode temporaries include the current Buffer,
decoded window, joined/trimmed/sliced line estimates and parsed response. Line and parsed-tree
charges clear after synchronous consumption; the current Buffer and window remain charged
while work is suspended and clear when consumed or cancelled.

Queue promotion moves the request charge to its active owner. Cancellation, timeout and full
admission release or avoid waiting charges. An uncooperative pending provider retains its
active request charge until actual settlement. Collection completion/failure clears its line,
part, metadata and transient charges; completion transfers the full result to the caller
outside the ledger. Accounts retain only numbers, and close is idempotent, including late callbacks.

These estimates add no rejection threshold and do not guarantee physical memory bounds.
Repeated strings and phase aliases can be overcounted. String backing stores, GC timing,
parser internals, provider/native buffers, caller-owned completed results and other gateway
paths are not fully represented. Synchronous measurements cannot capture every allocation
inside JSON parsing. Use the ledger to diagnose ownership and plan a byte policy, not as an
RSS measurement or proof of lower memory use.

The audit SSE shadow enforces the existing 100 MiB event budget while accumulating an
unterminated line, before retaining an oversized fragment. New chunks are scanned once;
previously accumulated incomplete lines are not rescanned on every push. UTF-8 decoding and
CRLF boundaries remain incremental. An oversized event clears retained shadow state and emits
one fixed omission marker. The remaining fragments are discarded through the blank event
boundary; later valid events resume parsing. Partial credential values are not conservatively
echoed across arbitrary oversized fragments. The error summary and raw byte offset remain
available for diagnosis. This omission affects diagnostic shadow/capture, not original SSE
forwarding. Input chunks already allocated by callers and JSON parsing near the budget can
still produce transient allocations beyond the retained-shadow estimate.

## Queue pressure

Audit settings use field-only patches and a non-secret `auditRevision` content
digest. Every public audit patch supplies `expectedAuditRevision`; the serialized
configuration owner checks it before persistence. A stale or missing revision is
a conflict, with no write or automatic replay. Other service settings retain their
existing patch contract. Revision fields are transport metadata and are never saved
in `gui_config.json`. An older owner without revision support leaves audit controls
disabled; Thought Store controls remain independent.

Numeric settings commit on blur/Enter. Feedback distinguishes saving, applied,
persisted-but-restart-required, conflict and unconfirmed failure. Failed writes
refresh the selected service snapshot; a failed refresh is reported separately.
Configured budgets, safe closed drop reasons and maintenance running/scheduled/
idle/stopped state are distinct from physical usage and actual capacity admission.
Unknown older-owner maintenance state is shown as unavailable.

Queue count/byte changes update the existing parent-side queue after the Worker's
configuration reply. They do not replace the SQLite actor, clear history or reset
accepted reservations. Lowering a budget can leave accepted work temporarily above
the new limit; it drains normally while later admission observes the new budget.
Capacity reclamation remains gradual and uses the existing bounded maintenance.

The shared worker bounds outstanding command count and estimated serialized command bytes.
Its model, auxiliary, background and control lanes use weighted scheduling. Background
traffic is limited to 10% of either budget; combined background and auxiliary traffic uses
at most 30%. Reads/control have their own 10% share. Global capacity still applies to all
lanes; these shares do not reserve an unconditional slot when model traffic fills the queue.

Rejected diagnostic writes return immediately. Accepted writes remain asynchronous, and
the owning service records rejected/failed persistence. Closing rejects new work and drains
accepted commands under the existing deadline. A command's serialized byte estimate is not
a bound on process RSS: JavaScript strings, serialization and native SQLite use additional
memory. Diagnostic writes retain their existing queue policy and have no automatic retry.

## Verification

Concise body display preserves every JSON field and type, including unknown business
fields and JSON text inside strings. Only recognized inline media fields are replaced
with a display-only UTF-8 byte-count marker; media context does not propagate into
arbitrary tool `data`. Full view/export and malformed/incomplete/SSE fallback retain
their existing meaning. Formatting is limited to the bounded editor window.

The [native retention tests](../../../scripts/acceptance/runtime/audit-retention-native.test.mjs)
cover bounded backlog convergence with model writes between passes, terminal writes, pinned-reader recovery, traffic-class priority and an existing free-page
backlog, including reclamation across two maintenance commands. The
[native Thought Store tests](../../../scripts/acceptance/runtime/thought-store-native.test.mjs)
cover bounded age/capacity session cleanup, bounded cold selection before decoding, preserved management history, Unicode and signatures across reopen, raw fallback and preserved corrupt gzip data.
The service-level capture test verifies that a decode failure leaves the generation request
unchanged and does not retry the failed hydration read.
Cold admission and service tests cover FIFO execution, waiting-time expiry, overload,
management admission during distinct-session bursts, cancellation and close-generation
replacement. Native pressure acceptance separates caller-retained bodies from cache retention.

See [native worker verification](../../testing.md#focused-commands) for matching Node/Electron
SQLite ABI requirements. These checks do not establish live-provider, installer or
cross-platform behavior.

# Gateway Storage and External Input Security

This reference owns audit/Thought retention, content capabilities, coding-tool files and local media access. The [global security reference](../../security.md) owns trust and validation rules.

## Query credential metadata

Gemini query-key admission uses the existing proxy credential identity. Normalization happens at
the HTTP ingress before gzip admission and audit session resolution; downstream owners do not
reparse the URL independently. The route scope and precedence are defined in the
[compatibility reference](compatibility.md#gemini-query-credentials).

Audit URL/query metadata, historical metadata read projections, cURL/HAR export and diagnostic
text redact query credentials, including percent-encoded parameter names. The URL/query boundary
treats `key` as a credential without changing ordinary business payload fields with that name.
Copying cURL with current-key inclusion remains an explicit choice; it cannot restore a captured
historical URL key. Raw OAuth callback input also remains credential-bearing data and does not
enter public errors or diagnostic payloads.

These changes do not rewrite historical audit rows, archive files, clipboard history or existing
backups. Previously captured originals can still contain sensitive values on disk and remain
subject to the profile's existing access and retention policy. No database migration or durable
format change is introduced.

## OpenCode account configuration

OpenCode refresh grants remain inside the selected owner and its existing external plugin account file; this integration does not introduce a Manager-side token-refresh mechanism. Normal responses contain strict status, intentional current configuration location metadata or a bounded redacted preview. Backup contents, backup/temporary locations, OAuth grants and dedicated keys do not cross control transport. OpenCode renderer routes bypass audit middleware. Configuration, local-account and OpenCode public errors preserve only validated closed categories and fixed messages; their IPC error logs omit raw input, values, causes and stacks. External plugin formats, account selection, backup recovery and native dedicated-key storage remain unchanged.

## Audit file export

Audit file export keeps body contents and destination paths outside renderer responses. Only the trusted desktop chooser supplies a bounded absolute destination; private input is independently bounded to 3,000 encoded bytes. The selected owner enforces the existing 100 MiB body ceiling while streaming, uses a new sibling temporary file with restrictive POSIX permissions and preserves the prior destination on failure before replacement. Parent-directory synchronization errors after replacement indicate uncertain durability rather than rollback. Export failures expose fixed text without filesystem/provider diagnostics. The desktop retains its creating adapter throughout selection and does not use embedded persistence on remote failure.

## Responses history ownership

Responses continuation, read and delete require the creating caller's existing proxy
credential identity. The store retains a versioned one-way digest, never the raw
credential. Equivalent Bearer/API-key headers agree; credential rotation changes the
identity. No encryption is added: conversation history remains plaintext under the
profile's OS permissions. Open mode remains unauthenticated and does not establish
distinct human identities; header-free callers share its anonymous scope.

Admission precedes history materialization and retention renewal. Unknown, foreign,
expired and missing HTTP cursors use the existing not-found envelope; WebSocket
durable-history admission uses the same ownership check. Parent and child ownership
must agree. Cancelled, failed and incomplete responses cannot publish completed
history. WebSocket and HTTP completions share the history writer and its caller
ownership checks. Explicit `store:false` prevents durable publication while retaining
the active WebSocket connection's transcript. A new connection may restore an owned
saved cursor without supplying its model again. Its later appends retain the recovered
transcript and effective model. Foreign and expired cursors are rejected before dispatch.

The active store reuses `openai-responses-sessions.json`, with the generic version-1 durable
envelope and the Responses-owned `sha256-v1:` caller codec. The strict current decoder rejects
records without the required owner and initial identity; the first store access atomically
replaces those unsupported entries. Other historical filenames are not searched, imported or
used as fallback. Unknown provenance is not guessed from an ID prefix.

The current format requires strict version-1 initial identity metadata (client/content origin
and a fixed-size task digest), plus a valid routing root for client-origin records. Earlier
cursors are unavailable even when caller ownership is valid, because their initial task
provenance was not retained. The human explicitly accepts restarting those conversations or
replaying history already held by the client. Initial task identity is captured before media
bounding and restored only after caller admission; it is not an authorization credential.
Existing capacity, expiry and atomic fail-open behavior continue for the active store. The
application does not create a migration backup; a downgrade that needs replaced history
requires a copy made before the cutover.

See the [upgrade guide](../../upgrade-guides/next/responses-history-ownership.md) for
credential changes, plaintext backups, write failure and downgrade limitations.

## Proxy traffic and thought persistence

Selected-owner audit management responses are validated and bounded below the ordinary control
response cap. Escaped body pages retain only complete chunks and continue from the first deferred
chunk. Owner admission/drain covers reads and mutations; transport failures never invoke local
fallbacks. Presentation journals retain at most 128 reference events and return at most 32 per
batch, without bodies or worker errors. Public audit IPC failures omit raw input, causes and
stacks. Repair retains the existing intentional backup-location result; this does not authorize
reading that backup through control RPC.

Explicit Thought/cURL content uses purpose- and resource-bound owner capabilities with epoch,
UUID, expiry and sequential byte cursors. Each content owner permits four snapshots and 256 MiB
of retained body buffers. Each chunk is at most 64 KiB before base64 encoding; normal control
limits remain unchanged. Completion, explicit close, expiry and owner drain release retention.
Disconnect cleanup is best-effort and diagnosed without values; expiry bounds orphan retention.
Thought detail intentionally returns plaintext thought, visible text, nullable reasoning signature
and per-part signature metadata to the requesting renderer. All four use the bounded content
transfer, with metadata JSON occupying its own measured segment. Their combined body has a 256 MiB operational transfer ceiling while
thought text retains its 64 MiB limit. cURL capabilities and commands stay in Electron main;
only copied status reaches React. The 8 MiB replay-body limit remains separate from the 64 MiB
quoted-command ceiling. Current gateway key inclusion remains opt-in; upstream credentials
remain prohibited. Public Thought/cURL errors omit raw inputs, contents, causes and stacks.

Traffic audit and Thought Store data live in separate SQLite databases under the proxy state
directory and are written by separate bounded worker threads. The model path is fail-open: queue
overflow, worker failure and shutdown-drain timeout are reported as counters but do not alter the
provider response. Read-only audit/Thought management calls are not recursively audited. Clear,
delete, repair and setting changes produce metadata-only admin events.

Resetting the drop baseline preserves request records. Clear also resets the selected
traffic class's drop baseline, or every class when no class is selected. Both operations
wait for already admitted drop writes before deleting persisted counts. New drops in
the selected scope remain pending until the reset finishes and survive a successful
reset. A failed reset retains unpersisted counts; a lost worker reply can leave the
persisted outcome uncertain and requires reading the current statistics before retrying.

Audit retention defaults to 24 hours for bodies, 30 days for summaries, 100,000 rows and
256 MiB on disk. Disk pressure removes admin events, then bodies in system, IPC, auxiliary
and model order, then summaries in the same traffic-class order. Body candidates use an
ordered partial index and a timestamp/ID cursor, with at most 32 candidates per page.
Each body batch targets the measured disk excess using stored-body bytes. Accumulated deletions
are reclaimed before adding a body that would reach the target: chunk and index pages can free
more space than their content size. Physical bytes are remeasured after every batch. A single
large body can exceed the required reclamation; the remaining candidates stay eligible for
later maintenance. Expired bodies retain metadata and a `disk_pressure` reason. Code rollback
does not restore evicted content.

Existing schema-v4 databases receive the partial index in place without rebuilding records.
The previous stored-byte index is removed. Process-status polling (`proc/getOperation` and
`proc/isProcessRunning`) and gateway status/model-availability polling bypass IPC audit;
process start and close operations retain ordinary audit records, including failures.

Maintenance is cooperative: each deletion batch or bounded incremental-vacuum step yields
its worker command back to the existing weighted queue. Statistics, list/detail reads and
new audit writes can run before maintenance completes. A yielded command keeps its original
ID, promise and queue-capacity reservation; only a final result or error settles it. Startup
and configuration maintenance passes run serially. Configuration reports completion only
after its own pass finishes, including available physical disk reclamation. A busy WAL checkpoint
stops further disk eviction and records the remaining pressure for a later pass. Unreclaimed free
pages request a bounded background continuation instead of discarding additional bodies.

Passes capture row-ID high-water marks and creation-time cutoffs, so concurrent arrivals do
not extend the pass or become eviction candidates after a clear reuses SQLite row IDs.
Row-limit work recounts candidates after interleaved mutations, so user deletions do not
cause additional eviction against a stale total. A read during maintenance can observe
committed partial eviction; no transaction or active SQLite iterator crosses a yield.
Vacuum work is capped at 128 pages per step, and body
deletion yields after at most 32 bodies or a 20 ms soft work budget. Individual SQLite
statements, checkpoints and filesystem calls can exceed that budget; it is not a latency
guarantee. Concurrent writes can leave the measured size above budget until a later pass.
Shutdown retains the existing admission closure, drain deadline and observable termination
failure semantics. Partial evictions survive a failure or forced termination; they are not
rolled back or reported as completed maintenance.

The dedicated `thinking-store.db` uses schema 2. Earlier Thought Store tables are reset
inside one SQLite transaction on open, with no import, backup or format fallback.
Failure rolls back the reset and closes the opening connection. Replacement refuses
unowned database objects and unknown future schema versions. It does not unlink database
or WAL/SHM files and does not touch adjacent account, audit or Responses stores.
See [required actions and downgrade limits](../../upgrade-guides/next/replace-thought-store-history.md).

Before an audit payload reaches SQLite, authorization and cookie headers, credential-bearing query
parameters, and recursively matched JSON credential keys are replaced with `[REDACTED]`. Media
bodies retain metadata and a SHA-256 digest, not bytes. Free-form prompt, code and tool output is
not heuristically scanned; users who place credentials in ordinary content are choosing to retain
that content in plaintext. Thought text and signatures are also plaintext by explicit product
policy. The UI automatically previews stored bodies up to 20 KiB. Larger bodies show a 20 KiB
prefix until the user chooses to browse more; signatures remain collapsed until expanded.

The Traffic Monitor's cURL export is an explicit local clipboard exception, not an audit-storage
exception. Its credential switch starts off for each page visit and resets on filter changes. When selected, the main process
substitutes the **current** local proxy API key into a parent-request command and writes it directly
to the OS clipboard; the renderer and IPC response never receive the key. Historical credentials
cannot be reconstructed from redacted records. Upstream-attempt export is always redacted. The
clipboard may be read by other local applications and the pasted command may disclose its key;
users should treat it as a secret and clear it when finished. Export refuses partial, expired,
binary or oversized request bodies rather than silently generating an incomplete replay.

Audit parent and attempt tables contain metadata and references, never large inline body columns.
Sanitized body content is written in 64 KiB chunks with a 100 MiB stored-prefix ceiling per unique
logical payload. Exact payloads may share a reference only inside the same parent request; there is
no cross-request content-addressed ownership or reference-count lifecycle. Normal SSE stores a
reconstructed response and preserves unrecognized events. Parse failures store redacted raw SSE,
framing and error location, not byte-identical upstream content. Authenticated body reads are paged
by default; the full-content route streams chunks and the renderer requires explicit confirmation
before accumulating a complete body for clipboard copy.

Both databases reject unknown future schema versions. Corruption does not trigger automatic
replacement. An authenticated explicit repair first closes the worker, then preserves the main
database and WAL/SHM sidecars under a timestamped `.corrupt-*` name before creating a fresh file.
Audit schemas 4, 5 and 6 receive an additive schema-7 migration after a verified
pre-migration SQLite snapshot. Existing requests, attempts and bodies are retained;
historical attempt timing is unknown. Older prototype layouts retain their separate
archive-and-rebuild policy. The independent Thought Store is untouched. See the
[upgrade and recovery guide](../../upgrade-guides/next/physical-attempt-usage.md).

HAR uses saved sanitized capture and the selected audit file owner. It never applies
the cURL current-credential opt-in. Private user-authored content can remain in
sanitized bodies. Review exports before sharing. Unknown origin, method and timing,
partial content and reconstructed SSE are explicitly identified in the
[export reference](traffic-diagnostics.md#har-export).

## Coding tool configuration files

Claude Code and Codex settings store the existing gateway API key in the client-readable format
required by each client. Their first `.antigravity-manager.bak` recovery file preserves the exact
original text and may contain credentials from a previous provider. These are explicit local
interoperability files, not Manager account-database migrations. Files use mode `0600` where
supported; Windows access follows the containing profile's ACL. Do not share, log or commit
these files. Backups and arbitrary client settings never cross the control transport; previews
project only model/address fields and a hidden credential marker. The user confirms complete
restore in the UI or supplies CLI `--yes`. See
[agent-tools reference](agent-tools.md) for the difference between removal
and restoration.

Independent connection profiles snapshot existing keys into separate OS-keyring accounts.
Their version-1 metadata catalog contains no raw key. Private field originals, first native
backups and interrupted-write ownership are AES-256-GCM encrypted using an independent
OS-keyring encryption key. The selected backend owns this catalog and its keyring entries.
The renderer receives only profile metadata and credential availability. Losing the encryption
key makes the ownership catalog unreadable. Operations fail without a plaintext fallback or
an automatic empty replacement. Preserve the catalog and the original user's keyring together.
These profile records do not change existing client snapshot or recovery-file formats.

## Local video paths

OpenAI Chat Completions local `video_url` paths are disabled by default. The user can enable
`proxy.experimental.allow_local_video_paths` in Settings; the running gateway reads this setting
for every request, so no restart is required. Once enabled, the existing proxy API-key boundary is
the only caller restriction and there is no directory allowlist: any authorized proxy client can
request any regular file readable by the desktop process. The Settings description must keep this
scope explicit. While the setting is disabled, `video_url` handling must not probe or read the local
filesystem; explicit local path forms are rejected lexically and ambiguous non-URL strings retain
the gateway's raw-Base64 fallback.

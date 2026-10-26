# Upgrade guide: Review the audit capacity window

Target version: next

## Affected users

Earlier builds can expire audit bodies after 24 hours and summaries after 30 days.
Audit retention now depends on disk and parent-request capacity, extending retention
while storage permits. Existing expired content cannot be restored. New or missing
settings use 1024 MiB and 100,000 parents; existing explicit limits are preserved.
This applies across platforms; current native validation covers Windows.

New audit writes can be refused at the configured disk budget. Model execution
continues independently. Capture limits still apply; capacity does not guarantee
complete capture. Thought Store, internal diagnostic files and credentials keep
their separate owners and policies.

Successful recognized health/model-directory GET probes are now omitted by default.
Enable **Capture successful probes** if their successful history is needed. Failed
probes and business GET requests remain captured when request history is enabled.
Existing history is not removed by this setting.

New model audit sessions use D03 scoped digests, including verified Responses
continuations. Older raw values remain readable but cannot safely be merged across
callers. Export those records per body; full session export accepts scoped keys
and refuses active/changed/oversized data. Desktop and standalone core must both
include the new operation. No database conversion or guessed backfill is performed.

Timing version `2` omits unmeasured stages instead of fabricating zeros. Custom
clients must treat absent stages as unknown; measured zero remains `0.000`.
Older saved zero stages are ambiguous. Recorded token scalars are not relabeled
provider-verified; missing/zero/inconsistent input does not imply a valid cache rate.

## Required action

1. Review the retention/privacy implications and configured disk/request limits.
   The obsolete audit age controls are removed. Use explicit deletion when needed.
2. Export needed history before lowering capacity. Maintenance removes the oldest
   completed parent requests with their attempts and bodies, targeting 70% under
   disk pressure. Row pressure returns only to the parent limit. Deletion cannot
   be undone; active captures can temporarily prevent reaching a target.
3. Save settings normally. Loading does not rewrite the file. The first save that
   removes old age fields requires a local pre-migration configuration backup.
   If saving fails, resolve the reported storage/backup problem and retry; the
   previous file and cached snapshot remain active. No restart is required to
   apply a successful capacity update.
4. Inspect storage/drop status. Release external SQLite readers holding an old
   snapshot, restore writable space after volume/permission failures, and check
   a subsequent capture. Do not delete sidecars while the application owns them.
5. If a separately managed standalone core is already running, stop and upgrade it
   with the desktop using the [owner upgrade procedure](process-diagnostics.md).
   Audit statistics and capture outcomes require owner compatibility `5`. An older
   owner is rejected before attachment; it is not silently replaced or stopped.
6. After an explicit clear, start a fresh request to verify new capture. In-flight
   captures in the cleared scope stop; other classes are unaffected. If clearing
   fails or its completion is unknown, refresh the list before retrying. Failure
   may still end older capture admission without confirming row deletion.

## Data and recovery

`gui_config.json.pre-audit-window-migration.bak` preserves the exact original
configuration before age fields are removed. It stays beside the configuration;
subsequent saves do not overwrite a valid copy. A directory or invalid snapshot
at that path blocks migration. Stop the application, preserve an obstructing or
damaged file for diagnosis, and restore a known valid copy or move the obstruction
aside before retrying. Configuration backups may contain sensitive local values;
do not attach them to diagnostics or commit them.

To restore old settings, stop the application, retain the current configuration
separately, copy the valid pre-migration backup over `gui_config.json`, then reopen
and verify the intended capacity/settings. Isolated ConfigManager tests exercise
backup, save failure, retry and restoration through a fresh owner. This procedure
does not recover deleted history or previously dropped body content.

SQLite dependencies, schema version and schema-opening policy are unchanged. No
profile reset or database conversion is required. Existing v4 history reopens.
Actual stored prefixes remain incomplete on admission refusal, with their reason;
failed failure-metadata persistence is reported explicitly. Reads/exports remain
available. The database, WAL and SHM count toward live usage. Recognized schema and
corruption backups, including their sidecars, have a separate displayed byte/file
total; they remain outside the live capacity budget and are never auto-deleted by
this change. An incomplete/inaccessible inventory is shown as unknown. The count
is files, not recoverable snapshots. No backup contents or paths are exposed.

On a new owner process, old unfinished audit captures are reconciled atomically.
They display as capture interrupted with unknown model outcome; recorded end time
is reconciliation time and duration remains unknown. Actual body prefixes remain
available and the records become eligible for configured capacity eviction.
Same-process Worker replacement preserves current captures. No requests are
replayed and no SQLite schema or stored outcome vocabulary is changed.

Explicit clear uses process-local generations and transactional scope deletion.
It neither deletes backups nor clears Thought Store/diagnostic files. Export now
reports failure rather than saving an empty/truncated success when saved content
disappears or changes during reading. The prior destination remains intact on
read failure; retry against a retained record. Terminal partial prefixes can be
exported as saved content. A snapshot fully read before a later clear can still
be saved without recreating deleted records.

## Downgrade

Audit-setting callers must read the selected owner's `auditRevision` and provide
it as `expectedAuditRevision` with each field patch. Missing/stale values fail with
`configCode: conflict` before saving; refresh and deliberately retry. These digests
are not durable configuration fields. Older owners without the capability cannot
receive an unguarded fallback from the new audit UI. Unrelated service settings and
Thought Store settings retain their existing patch contract. Queue-limit updates
keep the current Worker and let existing reservations drain under their original
acceptance; new admissions use the new limits after configuration acknowledgement.

There is no SQLite format conversion to undo. Restore the pre-migration
configuration with the application stopped if old age settings are needed.
An older build may resume age-based deletion and its previous admission behavior.
Upgrade or downgrade desktop and standalone core together. Older readers can
display a reconciled record's stored unknown model outcome as in progress even
though capture has ended; the new label is derived on read. This does not restore
missing content or establish model completion.
Older builds read scoped session fields as text but may not support scoped filter/
export semantics or the NDJSON format. Downgrade does not rewrite them to raw hints.
An actual previous application binary against these records has not been tested;
schema-v4 readback and configuration restoration are controlled evidence only.

## Verification

See the [current reference](../../modules/proxy-gateway/diagnostic-retention.md)
and [decision](../../../.agents/notes/implemented/bug-fix/2026-10-10-audit-reclamation-thought-decode.md).

The rebuilt production Worker checks ran with disposable databases and an ABI-matched
Electron process. They cover write refusal with retained read and reopen access,
whole-request eviction, and maintenance under row and disk pressure. See the
[admission test](../../../scripts/acceptance/runtime/audit-admission-native.test.mjs)
and [retention tests](../../../scripts/acceptance/runtime/audit-retention-native.test.mjs).

Real profiles, full-volume restoration, installed clients, live providers,
whole-process pressure, and other platforms remain unverified.

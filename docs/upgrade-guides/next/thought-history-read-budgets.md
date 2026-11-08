# Upgrade guide: use independent reasoning cache and durable retention

Target version: next

## Affected users

Users with unusually large or damaged saved reasoning metadata, incorrect stored
logical sizes or complete sessions above the read budget may now receive an explicit
unavailable-history result. Normal existing 200-turn sessions, raw/gzip text and
large per-part signature transfers remain supported within the stated budgets.

## Required action

1. Upgrade desktop and standalone core together; owner compatibility is now 9, retaining
   the Thought Store disk contract from compatibility 6 and adding the
   [local error window](local-error-window.md) and
   [physical-attempt audit migration](physical-attempt-usage.md). A
   mismatched running owner is refused without fallback or automatic termination.
   Existing schema-2 databases receive a transactional additive schema-3 upgrade
   preserving their rows and original bytes; no profile reset is required. The
   [authorized schema-0/1 replacement](replace-thought-store-history.md) is unchanged.
2. If a full-session body read is refused, inspect the session metadata and select
   individual records where available. Do not clear or repair the database merely
   to retry a rejected read.
3. After a transient read failure, a later independent generation request may retry
   hydration after one second. No model request or tool is automatically replayed.
   Read, admission and write failure counters are distinct.

## Data and recovery

Schema 3 adds operation, causal-history and original-completion fields plus bounded
tool-association references/indexes. Existing schema-2 content stays unchanged;
its unknown provenance is not invented or backfilled into recoverable tool links.
Compressed formats are unchanged. Reads preflight
sizes and bound gzip output; oversized/corrupt data remains stored for diagnosis.
There is no automatic content rewrite, deletion or decompression repair. Preserve the
local database through the existing private backup procedure before any separate
manual intervention; do not attach private thoughts or signatures to reports.

L1 defaults to 600 turns and supports 10–10,000, with a 64 MiB session maximum and
the existing global 256 MiB retained-cache budget. Explicit older 200-turn settings
stay 200. Old 1–9 limits load as 10 with a fixed warning; missing limits use 600.
The first save preserves exact original configuration bytes beside `gui_config.json`
as `.pre-thought-window-migration.bak`. The copy is private and never overwritten
by later saves. A damaged copy blocks saving until explicitly investigated.

To restore the old configuration, stop every app/core process, preserve the current
file separately, copy the valid backup over `gui_config.json`, then reopen and read
back the intended values. Isolated ConfigManager tests exercise exact copy, failed
save, deliberate retry and fresh-owner restoration. Restoring settings does not
restore history deleted by the independent retention policy.

Complete reads support at most 10,000 records, 16 MiB per JSON metadata field and
100 MiB retained/structured serialized reply. Thought text retains its 64 MiB decode
ceiling. A recent cold window can return less than a complete session. A failed read
does not extend durable idle retention. Successful management reads are read-only;
generation access uses a separately admitted write. Durable history is no longer
trimmed to the L1 turn/session-byte window. It keeps the independent 15-idle-day,
2,000-session and 1,024 MiB DB/WAL/SHM policy. Pressure cleanup is bounded and protects
recently used sessions; inability to make room refuses persistence without stopping
generation. The in-memory copy alone does not promise recovery after restart.

Deleting/ending history invalidates current request captures and open content handles
before waiting for accepted writes. A failed operation can therefore leave old handles
unusable while stored rows remain: refresh history to establish the current state.
Requests begun after completion can capture new history; no old response is replayed.
Maintenance protects its admitted active-request snapshot, including older sessions.

The private selected-owner record-list response is now a versioned metadata page;
desktop and core must be upgraded together under compatibility 9. The diagnostic
panel follows bounded cursors to inspect history beyond the complete-read limit.
Existing HTTP complete reads still refuse over-budget results. HTTP callers can use
the new `/v1/thinking/sessions/:sessionId/records` metadata route; see the
[management contract](../../modules/proxy-gateway/diagnostic-retention.md#reasoning-history-management).
Existing HTTP mutation fields retain their meanings and add durable record counts.

## Downgrade

New Thought client scopes use a canonical digest instead of the earlier cleaned
session-key suffix. Existing rows stay inspectable through internal diagnostics;
new client-hint HTTP lookups do not guess an old mapping. There is no automatic
credential-dependent backfill. Responses JSON keeps its existing envelope and adds
an optional validated ownership key to new history. Older records remain unknown
for scoped cleanup. A global clear can remove unknown history through its actual
selected process owner, including while its gateway is stopped. Confirm the peer
receipt before treating every store as cleared; unavailable/terminal owners and
failed JSON replacement remain unconfirmed.

Before a separate manual rollback, stop every app/core writer and preserve private
copies of both SQLite and `openai-responses-sessions.json` under the existing backup
policy. Restoring one file does not restore the other or any already delivered
response. Isolated tests execute Responses copy restoration and new-owner readback;
an actual older installed binary is untested. An older writer may discard ownership
metadata it does not understand, so do not infer scoped deletion coverage after
downgrade. No new automatic Responses backup is created by this change.

Schema-2 binaries reject schema 3. To return to an older binary, stop every app/core
owner and preserve the current private database, then restore a separately preserved
pre-upgrade schema-2 copy using the existing backup policy. Never lower `user_version`
or manually drop provenance columns. This restores only the contents of that copy;
post-upgrade captures are absent. Isolated tests execute this offline copy restoration
and reopen it through the upgrading owner. An actual older installed binary remains
untested. Without a valid older copy, retain the upgraded database and current binary
until a deliberate cache-loss procedure is agreed. Old schema-2 builds can also
prune durable history to 200 turns/session bytes. Schema-0/1 binaries retain the
separate replacement guide's constraints.
Owner compatibility 9 prevents mixed live owners; it does not make an old installed
binary safe against expanded history. Actual older-binary downgrade remains untested.

## Verification

See the [current reference](../../modules/proxy-gateway/diagnostic-retention.md).

The service tests cover recovery on a later request and cancellation while another
request still needs the same history. Tests in an ABI-matched production Worker cover
metadata, decompression and record-count limits while preserving stored data. They
also reopen a 700-turn session and check that more than 10,000 rows can stay on disk.
See the [cold-session tests](../../../src/tests/unit/thought-store-cold-session.test.ts)
and [native Worker tests](../../../scripts/acceptance/runtime/thought-store-native.test.mjs).

Separate checks cover bounded cleanup, a pause for a pinned reader, and cleanup stopping
when the database stops shrinking. They also cover configuration restoration and audit
admission. See the
[native retention tests](../../../scripts/acceptance/runtime/thought-retention-native.test.mjs),
[configuration restoration tests](../../../src/tests/unit/config-manager-thought-window.test.ts),
and [native audit admission test](../../../scripts/acceptance/runtime/audit-admission-native.test.mjs).

New complete streams publish one physical round only after upstream end; failed or
abandoned staging is unavailable for automatic recovery. Tool associations expire
seven days after original completion and have a separate 10,000-reference durable
cap; expiry does not erase the diagnostic body. Full-history causal candidates can
recover an older round beyond the L1 window, while ambiguous/truncated history can
still miss. Focused tests cover migration rollback and restoration, candidate lookups
beyond the in-memory window, expiration based on original completion, and publication
only after a stream completes. See the
[round persistence tests](../../../src/tests/unit/thought-round-database.test.ts)
and [stream capture tests](../../../src/tests/unit/thought-stream-capture.test.ts).

Scoped cleanup now also covers the registered signature, Responses, and live socket
owners with partial-outcome receipts. Responses metadata has one lazy process owner
across gateway stop/start.

A whole-process cap for in-memory and legacy associations remains open. Integrated
compaction and diagnostics, installed UI, live providers, sustained RSS pressure,
and other platforms remain unverified.

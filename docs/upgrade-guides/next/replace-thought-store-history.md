# Upgrade guide: restart cached thought history

Target version: next

## Affected users

All platforms using a Thought Store database written with schema 0 or 1. Its aggregate
signature cannot prove ownership of parallel tool calls. Schema 2 therefore replaces the
old Thought Store tables rather than converting them. Accounts, configuration, audit
traffic and Responses continuation files use their separate existing stores.

## Required action

1. Stop the application and its standalone core before replacing the installed version.
2. Expect previous cached thinking/signature records to disappear when Thought Store first
   opens. The application does not create an automatic backup or import those records.
3. Start a new conversation, or replay complete client-held history with its original
   signatures. A signature that was already lost cannot be reconstructed from old cache data.
4. Keep all running desktop/core processes on the same version; the Thought detail transfer
   also includes a separate part-signature segment in this version.

## Data and recovery

The Thought Store repository owns one immediate SQLite transaction that drops its old
tables, creates the replacement schema and verifies its columns before committing version 2.
SQLite owns WAL/SHM handling. An initialization failure rolls the transaction back and closes
the opening connection; it does not automatically repeat the operation. A later application
open can attempt initialization again after the underlying failure is corrected.

There is no restoration of old thinking history after a successful reset. Do not use the
corruption repair action to import an old copy. Unknown future versions or databases containing
unowned tables, views or triggers fail before replacement. Investigate the path/version error;
never point this repository at another feature's database. Other feature data is unaffected.
Only isolated databases have been opened for this implementation's verification.

## Downgrade

Older versions reject schema 2. Close every app/core process first. To downgrade, use a fresh
profile, or explicitly discard only `thinking-store.db` and its `-wal`/`-shm` sidecars in the
selected profile's proxy state directory after confirming all processes have stopped.
Do not discard the directory or other database files. The older binary can then create its
own empty Thought Store; neither direction restores cached thinking history.
The older application itself has not been run for this controlled check.

## Verification

Isolated native SQLite tests exercise version-one replacement, rollback after injected
replacement failure, refusal of unrelated/future databases, exact signature save/load/reopen
and metadata byte limits. See the
[SQLite tests](../../../src/tests/unit/thought-part-signature-database.test.ts).

The production Worker checks save and history-ingest round trips across thread restart.
Mapper and service tests verify that parallel calls restore their own signatures and that
ambiguous calls remain unsigned. See the
[Worker tests](../../../scripts/acceptance/runtime/thought-part-signatures-native.test.mjs)
and [signature restoration tests](../../../src/tests/unit/thought-part-signature-persistence.test.ts).

See the [decision](../../../.agents/notes/implemented/bug-fix/2026-10-18-thought-part-signature-persistence.md)
and [current compatibility behavior](../../modules/proxy-gateway/compatibility.md).
Real provider, actual user profiles, installed clients and the platform matrix remain deferred.

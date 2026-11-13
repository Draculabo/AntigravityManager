# Upgrade guide: Preserve audit and account history for physical-attempt usage

Target version: next

## Affected users

The account database gains a nullable private identity column. Audit schema 4, 5 or 6
upgrades to schema 7. Desktop and standalone core require owner compatibility 11.
Older prototype audit layouts keep their existing separate preservation policy.

## Required action

1. Stop the application and standalone core. Preserve the profile and provide space
   for an extra account database and audit database copy.
2. Upgrade the application and core together. The account owner creates a sibling
   `.google-usage-backup-<time>-<uuid>` SQLite snapshot, checks its integrity, and
   synchronizes it before adding the column. The audit owner checkpoints WAL, creates
   a `.schema-v4-backup-<time>-<uuid>`, `.schema-v5-backup-<time>-<uuid>` or
   `.schema-v6-backup-<time>-<uuid>` snapshot,
   checks its version and integrity, and synchronizes it before its transaction.
3. Keep the backups until the new version and any intended recovery have been checked.
   New verified Google enrollments can connect retained attempts across re-additions.
   Historical rows without identity proof are not backfilled.

## Data and recovery

Backups inherit the profile's access controls. The account backup contains local
OAuth credentials, including plaintext token JSON. The audit backup may contain saved
diagnostic content. Restrict access and do not share either as an ordinary log.
Failure to create or verify a backup stops the corresponding migration. Failed backup
artifacts can remain; their filenames do not establish that they are valid.

The nullable identity column does not rewrite existing account credentials, quota,
or account fields. The audit transaction adds nullable columns and indexes without
rewriting retained request rows, attempts, or bodies. A failed schema transaction
rolls back its column and version changes and leaves the backup in place.

Schema 7 adds nullable versioned per-attempt timing. Existing attempts remain
readable with unknown timing; no historical stage values are synthesized. HAR
export is a new selected-owner operation, so mixed application/Core versions are
rejected at the existing handshake before using an incompatible owner.

For offline restoration, stop every process using the profile. Preserve the current
account and audit databases and their WAL and SHM sidecars as separate sets. Verify
each intended backup with SQLite integrity and data readback checks before copying it
to its original path without unrelated sidecars. Restoring the account database also
restores its earlier credentials and account state. Restoring an audit backup omits
history written after the snapshot. Keep the newer sets for a later upgrade. This
procedure was rehearsed for a synthetic audit database only. Rehearse account
restoration on a copy before using it on a profile.

## Downgrade

Schema-4, schema-5 and schema-6 audit owners reject schema 7. Restore a verified pre-upgrade
audit snapshot offline before opening the older release, and downgrade application
and core together. Do not lower `user_version` manually. Preserve the newer database
set before restoration so later audit history is not discarded.

The pre-change account owner selects its known columns and ignores the additional
nullable column. It does not manage the new proof. Restore an account backup only
when the earlier account state is required, and account for the credential rollback.

## Verification

The [timing migration test](../../../src/tests/unit/upstream-attempt-timing-database.test.ts)
opens a populated schema-6 database with native SQLite, verifies the backup, restores
a copy, upgrades it again, and reopens recorded timing. The
[audit worker persistence checks](../../../scripts/acceptance/runtime/audit-persistence-native.test.mjs)
cover current-schema reopen, prototype archival, and rejection of future versions.
These D15 checks do not cover account credential restoration or populated schema-4
and schema-5 migrations. Packaged installation and live-provider verification are
separate acceptance checks.

See [current behavior](../../modules/proxy-gateway/diagnostic-retention.md#physical-attempt-usage-accounting)
and the [owning decision](../../../.agents/notes/implemented/feature/2026-10-17-retained-cycle-usage-query.md).

# Upgrade guide: Preserve audit and account history for physical-attempt usage

Target version: next

## Affected users

The account database gains a nullable private identity column. Audit schema 4 or 5
upgrades to schema 6. Desktop and standalone core require owner compatibility 10.
Older prototype audit layouts keep their existing separate preservation policy.

## Required action

1. Stop the application and standalone core. Preserve the profile and provide space
   for an extra account database and audit database copy.
2. Upgrade the application and core together. The account owner creates a sibling
   `.google-usage-backup-<time>-<uuid>` SQLite snapshot, checks its integrity, and
   synchronizes it before adding the column. The audit owner checkpoints WAL, creates
   a `.schema-v4-backup-<time>-<uuid>` or `.schema-v5-backup-<time>-<uuid>` snapshot,
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

For offline restoration, stop every process using the profile. Preserve the current
account and audit databases and their WAL and SHM sidecars as separate sets. Verify
each intended backup with SQLite integrity and data readback checks before copying it
to its original path without unrelated sidecars. Restoring the account database also
restores its earlier credentials and account state. Restoring an audit backup omits
history written after the snapshot. Keep the newer sets for a later upgrade. This
procedure has not been executed for this change; rehearse it on copies first.

## Downgrade

Schema-4 and schema-5 audit owners reject schema 6. Restore a verified pre-upgrade
audit snapshot offline before opening the older release, and downgrade application
and core together. Do not lower `user_version` manually. Preserve the newer database
set before restoration so later audit history is not discarded.

The pre-change account owner selects its known columns and ignores the additional
nullable column. It does not manage the new proof. Restore an account backup only
when the earlier account state is required, and account for the credential rollback.

## Verification

No migration, restoration, native SQLite, tests, type-check, packaging, or live-provider
checks were executed for this change. Source review does not establish recovery safety.
Required later evidence includes populated schema-4 and schema-5 WAL upgrades, account
backup readback, rollback and restart, offline restoration, and verified same-subject,
different-subject, credential-replacement, retry, and partial-stream accounting.

See [current behavior](../../modules/proxy-gateway/diagnostic-retention.md#physical-attempt-usage-accounting)
and the [owning decision](../../../.agents/notes/implemented/feature/2026-10-17-retained-cycle-usage-query.md).

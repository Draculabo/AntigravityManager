# Upgrade guide: Account incarnation and deletion cleanup

Target version: next

## Affected users

Existing desktop and standalone-core profiles migrate their account database
automatically. OAuth credentials, protocol settings and account export formats do
not require conversion. Account deletion also clears its matching saved preference.

## Required action

No manual SQL conversion is needed. Let the selected profile owner start normally.
Close all owners before making a profile backup or replacing an account database.
Protect database and configuration backups with the same permissions as the profile.

## Data and recovery

The migration transaction adds an internal column, backfills accounts and installs
an insert trigger. Failure rolls back this migration without deleting accounts or
retrying provider requests. Stop the owner before restoring a known-good database
backup, restart, and verify the account list. Preference cleanup is a separate
post-deletion effect: failure leaves the account deleted. Inspect the list and
settings before an explicit deletion retry, which deletes the current ID again.

## Downgrade

The change is additive. Isolated SQLite tests verify older writes naming only
known columns; the trigger supplies new insertion incarnations. Older releases do
not enforce the new guards. Packaged older-binary downgrade is unverified. Retain a
stopped-owner backup when returning to an older release, and keep profile ownership
exclusive. Restoring a running owner's database is unsupported.

## Verification

Controlled tests cover stable backfill/reopen, old-column writes, same-value
recreation, migration rollback and stopped-owner backup restoration. They use
temporary synthetic databases under Node 24, not real credentials or packaged
Electron acceptance. Verify normal account-list loading and that deleting a
preferred account removes its matching setting after reload. See the
[account reference](../../modules/cloud-account/overview.md#stored-account-incarnation).

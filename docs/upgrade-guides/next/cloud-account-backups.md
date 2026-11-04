# Upgrade guide: Preserve both account database versions

Target version: next

## Affected users

Users on Windows, Linux or macOS whose profile contains cloud-account fields encrypted by an older
release. Already converted plaintext profiles start normally without loading an old master key or
creating a new migration pair. Older encrypted backups are not modified automatically.

## Required action

1. Stop other Manager/Core processes using the same profile and keep the original machine's key
   available. Preserve the profile before upgrading.
2. Start the updated application on that machine. Startup converts old account fields only after
   preserving both database versions. A key, validation, storage or verification failure stops
   startup; correct the reported condition before retrying.
3. Confirm the account list and settings, and retain the completed backup directory privately.
   Before transferring old encrypted data, complete this step on the original machine.

## Data and recovery

The [account storage contract](../../modules/cloud-account/security.md#account-storage-and-conversion)
defines `<database>.account-migration-<random-suffix>/encrypted.db` and `decrypted.db`, their
verification, private permissions and failure behavior. Each pair preserves a complete database,
including settings and workspace rows. Both completed files are retained after final conversion
failure; partial attempts may contain only the encrypted file and an unconfirmed pending file.

To restore, stop all Manager/Core processes, move the current database and any matching WAL/SHM
to a private recovery location, and copy the chosen completed backup into the original database
path. Do not reuse displaced WAL/SHM files or edit the historical backup itself. A decrypted copy
does not require the old key. An encrypted copy or historical `.encrypted-backup-*` file requires
the original key for conversion. Restart and verify accounts and saved settings. Data added after
the chosen backup is not included; keep the displaced files for recovery. Local copies cannot
recover a lost disk or profile.

## Downgrade

No SQLite schema changes are introduced. Reading the plaintext fields with an older version still
depends on that version's schema and storage policy. Releases that encrypt plaintext on startup
can reintroduce the old key dependency. Restore an encrypted working copy only with its original
key available. A code revert does not restore account data; live downgrade remains unverified.

## Verification

Real disposable SQLite tests exercise encrypted and plaintext backup reopen, WAL data, full
account/settings/workspace preservation, both working-copy recovery paths, retained history and
failure before live conversion. The [focused persistence checks](../../modules/cloud-account/overview.md#focused-persistence-checks)
document the owning entry. Windows Electron and WSL results are recorded with the implementation;
native macOS, installed upgrade and power-loss durability are not established by these tests.

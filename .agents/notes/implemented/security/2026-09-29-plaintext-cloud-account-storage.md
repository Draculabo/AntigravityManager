# Agent Note: store cloud accounts as local plaintext JSON

Status: implemented

## Problem

Field-level encryption of cloud-account rows made an older application unable to read accounts
after a newer release had started. It also required a master key and OS keyring during ordinary
desktop and standalone-core startup. The user chose to remove that encryption and retain existing
accounts through a one-time conversion.

## Decision

`token_json`, `quota_json` and `health_json` are written as validated plaintext JSON. Desktop and
standalone core check for old ciphertext at startup. Only when ciphertext exists, the runtime loads
the old key providers, validates every decoded field and preserves two complete SQLite databases
in a unique private sibling directory. `encrypted.db` retains the pre-conversion account fields,
including committed WAL data. A separate working copy becomes `decrypted.db`, without changing
the live database. Both are reopened for integrity and account-field comparison before the live
conversion transaction. That transaction refuses account fields changed across asynchronous
key/backup work. Any decryption, validation, backup or readback failure aborts startup without
converting live rows. No new account writes use the master key.

The maintainer requires both representations to remain independently recoverable. Completed pairs
are permanent history, with a new directory per attempt; neither retries nor account deletion
automatically prune them. A failed plaintext preparation can retain an encrypted copy and an
unconfirmed pending file. A failed final live transaction retains both completed copies. Using
SQLite's online backup avoids missing committed WAL pages; converting an offline copy avoids
making plaintext recovery depend on a successful later backup of the already-converted live DB.

This supersedes the account-encryption behavior in
[the Node-safe master-key note](2026-09-24-node-safe-master-key-runtime.md) and
[the encrypted-record migration note](2026-08-27-legacy-encrypted-account-migration.md).
Their key providers remain only to recover old account rows during conversion.

## Alternatives considered

- Abandon ciphertext rows and require every account to sign in again. This would lose working
  local account state.
- Read old ciphertext indefinitely while writing new plaintext. This would retain an ongoing
  keyring dependency and leave old releases unable to read the remaining ciphertext.
- Continue encrypting new writes. This would keep the downgrade failure the user reported.
- Back up plaintext only after committing live conversion. A backup failure would leave no
  independent plaintext recovery artifact and a retry would see no ciphertext to convert.

## Consequences

Anyone who can read the profile database or a plaintext backup can read cloud OAuth access and
refresh tokens. OS account and filesystem permissions are the remaining local protection. The
conversion history contains both ciphertext and plaintext and is retained for manual recovery.
Copies live beside the profile and do not protect against losing the entire disk. Completed
backups are self-contained without WAL/SHM files; recovery uses working copies with every profile
owner stopped and preserves the displaced database and sidecars together. Older application
versions can read converted JSON fields when their SQLite schema and other settings remain
compatible. A release that still encrypts plaintext rows on startup will re-encrypt them, so
switching back and forth across that release boundary is not supported. This decision does not
guarantee downgrade compatibility for unrelated schema changes.

A standalone core can convert only ciphertext whose old key is available to its Node key provider.
When the key exists only in Electron's old provider, the core fails before mutation; launching the
desktop once with the same profile performs conversion for subsequent core runs.

## Verification

Focused tests cover plaintext batch writes, no-key startup, real SQLite backup ordering and WAL
preservation, complete account/settings/workspace data, independent no-key plaintext recovery,
encrypted working-copy recovery, retained history, failed publication/readback, changed accounts
and final transaction rollback. A selected preservation regression fails against the earlier
single-backup implementation. Windows Electron and WSL runs exercise native SQLite with isolated
synthetic profiles; native macOS, live upgrade and power-loss durability remain unverified.
Type-check and governance checks validate the affected contracts and documentation.

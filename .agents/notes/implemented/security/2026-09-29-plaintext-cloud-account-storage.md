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
the old key providers, validates every decoded field, writes an SQLite backup alongside the
database and replaces all encrypted fields in one transaction. Any decryption, validation or
backup failure aborts startup without changing rows. No new account writes use the master key.

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

## Consequences

Anyone who can read the profile database or a plaintext backup can read cloud OAuth access and
refresh tokens. OS account and filesystem permissions are the remaining local protection. The
conversion backup contains old ciphertext and is retained for manual recovery. Older application
versions can read converted JSON fields when their SQLite schema and other settings remain
compatible. A release that still encrypts plaintext rows on startup will re-encrypt them, so
switching back and forth across that release boundary is not supported. This decision does not
guarantee downgrade compatibility for unrelated schema changes.

A standalone core can convert only ciphertext whose old key is available to its Node key provider.
When the key exists only in Electron's old provider, the core fails before mutation; launching the
desktop once with the same profile performs conversion for subsequent core runs.

## Verification

Focused tests cover plaintext batch writes, no-key startup for plaintext accounts, conversion
backup ordering, failure before mutation and desktop initialization. Type-check and governance
checks validate the affected contracts and documentation.

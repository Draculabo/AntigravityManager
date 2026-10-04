# Agent Note: Node-safe master-key runtime

Status: implemented

The ongoing account-encryption behavior in this note was superseded by
[plaintext cloud-account storage](2026-09-29-plaintext-cloud-account-storage.md). The old key
providers now serve only the one-time conversion of existing encrypted rows.

## Problem

The shared account encryption module imported Electron at load time. A standalone Node service
could not read existing encrypted accounts, and a new master key would make their ciphertext
unrecoverable if it replaced the desktop key.

## Decision

The shared security module defaults to the existing `AntigravityManager / MasterKeyV2` OS keyring
entry. The Electron bootstrap explicitly configures its existing providers before account
initialization. Once the desktop resolves the key using account ciphertext, it attempts to copy
those exact key bytes into an empty OS keyring entry and verifies the result. It does not overwrite
a different entry. A plain Node runtime has no file-backed fallback and fails closed if the keyring
is unavailable or its key cannot decrypt existing account data.

Desktop initialization retains its current provider order for key resolution, but V2 and legacy
file providers are read-only. It verifies the keyring copy before any account ciphertext migration.
An unavailable or conflicting keyring stops desktop account and gateway startup. The copy does not
change SQLite rows or ciphertext formats.

## Alternatives considered

- Put the canonical key in a new file under the agent data directory. This would add plaintext
  master-key material and was rejected for the standalone service.
- Continue desktop startup when the OS keyring is unavailable. That would let account migration
  write ciphertext under a key the standalone service cannot recover.
- Re-encrypt every account record for the service. The same key can be shared safely through the
  keyring, so rewriting account ciphertext adds migration risk without a need.

## Consequences

The desktop and future standalone service use the same keyring entry. Existing file keys remain
readable to recover account data, but no runtime creates a new file-backed master key. A
conflicting keyring entry requires explicit recovery; it is never replaced automatically. Startup
must report keyring failure rather than opening an empty account state or mutating account rows.

## Verification

- Focused tests cover plain-Node import, new key creation, loss of keyring access, lost existing
  keys, desktop-to-Node key copying, and conflicting entries.
- Desktop startup tests verify keyring readback precedes account-row migration and that failure
  stops the sequence. Existing encrypted-account migration tests and TypeScript/runtime-boundary
  checks validate the preserved data format.

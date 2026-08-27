# Agent Note: migrate legacy encrypted account data to the primary key

Status: implemented

## Problem

Older account records can contain plaintext JSON hidden behind leading whitespace or ciphertext encrypted with a previous data-encryption key. Leaving either form in place retains avoidable plaintext or makes recovery depend indefinitely on a historical fallback key.

## Decision

The account codec treats whitespace-prefixed JSON as legacy plaintext, decodes it, and persists the equivalent record through the current encrypted storage path. When a fallback key decrypts a legacy ciphertext, the codec re-encrypts the recovered plaintext with the primary key before the record is next persisted.

Migration remains opportunistic and record-local: a record that cannot be decoded still follows the existing error path, and migration does not alter credential locations, account identity, or the database schema.

## Alternatives considered

- Keep fallback-encrypted values indefinitely. This preserves readability but extends the lifetime and operational importance of retired keys.
- Run a database-wide migration at startup. This adds failure and rollback scope to application startup without benefiting records that are never read.
- Rewrite raw ciphertext without decoding the account record. This bypasses the existing validation and encryption boundary.

## Consequences

Records are gradually normalized as users access them. After a successful fallback-key recovery, later reads use the primary key and do not require the fallback key. Historical plaintext with leading whitespace is no longer retained after successful migration.

The migration writes durable account data. A storage failure can leave the original record in place, so the code must preserve the existing successful decode result and surface the write failure through the normal persistence error path rather than claiming migration completed.

## Verification

- Unit tests cover whitespace-prefixed legacy JSON migration, fallback-key recovery followed by primary-key re-encryption, and migration through the cloud-account handler.
- The focused migration suites passed before the associated security PR was merged; this note is documentation-only and does not alter runtime behavior.

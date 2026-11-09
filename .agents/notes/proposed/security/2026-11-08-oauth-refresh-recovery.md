# Agent Note: OAuth refresh recovery

Status: proposed

## Problem

An OAuth refresh can rotate credentials before the updated account row is saved. An interrupted
process or a persistent SQLite failure can leave the prior refresh token on disk. An in-memory retry
cannot survive process termination. A lost provider response can also leave the remote outcome
unknown, even when local persistence has not started.

## Proposal

The cloud-account owner will persist a versioned, bounded recovery record immediately after receiving
a successful refresh response and before reporting the refreshed lease as durable. Each record will
identify the account, the expected prior OAuth identity and the resulting token state. It will not be
exposed through renderer IPC or written to logs. Storage must use the existing credential protection
policy, including an explicit, independently verified Windows access-control strategy; POSIX mode
bits alone are not evidence of Windows privacy. The implementation must serialize mutations per
account and coordinate with the profile owner.

On startup, before accounts can be leased or refreshed, the owner will validate each record and
compare the persisted OAuth identity atomically. Matching prior credentials permit recovery;
already-applied credentials permit idempotent cleanup; different credentials or a deleted account
must never be overwritten. Unknown versions, malformed records, read errors and ambiguous outcomes
must fail closed for the affected account and preserve the evidence for recovery. Removal must occur
only after the durable database result is confirmed. The recovery contract must define its handling
of independent project and proxy updates, retries, account deletion, and reauthorization.

## Alternatives considered

- Keep only the in-memory retry: it cannot survive a crash.
- Write only to SQLite: a database write failure can lose a rotated token on process exit.
- Blindly replay a recovery record: it could overwrite newer authorization or resurrect a deletion.

## Acceptance criteria

- Fault-injection tests cover interruption after journal commit, SQLite commit and before cleanup;
  a fresh process recovers without sending another refresh request.
- Tests cover reauthorization, deletion, already-applied state, concurrent updates, corrupt and
  unknown versions, storage failure, permissions and cleanup failure on supported platforms.
- Verification reads the authoritative persisted account and confirms no credential appears in logs.
- Current security and recovery documentation explains credential location, permissions, backup,
  retention and manual recovery; incompatible upgrades have an explicit compatibility policy.

## Risks

No local design can guarantee recovery when the process dies after the provider rotates a token but
before any durable local write, or when all durable storage is unavailable. Reauthorization may be
required. A recovery record is an additional copy of sensitive credentials and can outlive an
account; its privacy, retention and deletion policy need native-platform verification. A local
journal cannot establish the outcome of an OAuth response lost in transit.

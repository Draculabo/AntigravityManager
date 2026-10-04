# Agent Note: Clear current-account references after account deletion

Status: implemented

## Problem

Deleting a cloud account removed its account row but retained the per-client current-account
settings. Subsequent automatic-switch checks repeatedly warned that the referenced account
no longer existed. Desktop and standalone service deletion already share the same repository.

## Decision

The account repository deletes the account and clears missing current-account references in one
SQLite transaction. Repository initialization also clears historical references after existing
encrypted-field conversion completes. Cleanup examines only the three supported client keys,
validates their JSON string values, and checks account existence without loading credentials.
The settings store owns the key format and cleanup operation. Existing persisted formats and
database schemas remain unchanged.

## Alternatives considered

- Clearing only in the UI misses CLI deletion and historical records.
- Suppressing monitor warnings preserves invalid saved state.
- Separate deletion and cleanup commits can leave partial state on failure.
- Selecting another account automatically changes client behavior without an explicit switch.

## Consequences

Cleanup failure prevents deletion or initialization from reporting success. Supported references
to existing accounts, unrelated settings and malformed values remain unchanged. Removing the
Manager record does not sign out an official client, change its credentials, or imply that a
proxy request previously used a deleted account. Existing global-active fallback policy is unchanged.

## Verification

Five native SQLite regression checks failed against the original repository and passed after the
fix under Windows Electron 37.10.3 in Node mode. They cover multi-client deletion, repeat deletion,
startup recovery and idempotency, deletion rollback, and startup rollback. The complete focused
set also covers plaintext/encrypted account persistence, desktop/standalone adapters, settings and
core RPC: 42 tests pass. Each persistence test uses a disposable database, never a personal profile.
No live provider, installed official-client or Linux/macOS acceptance is claimed by these checks.

# Identity Profile Module

The `identity-profile` module owns client identity profile behavior and desktop identity-storage
initialization. Cloud-account collection and account switching call its narrow services when they
need to prepare or apply a client profile. See [architecture](../../architecture.md#feature-ownership)
for the module boundary.

## Desktop storage initialization

Account collection and client switching resolve the target application and profile directory
before preparing `storage.json`:

- OAuth account addition, JSON account import, confirmed local account import, and local account
  snapshots prepare storage for the resolved desktop target. An import that persists no accounts
  does not initialize files.
- IDE synchronization prepares storage for its selected target. GUI switching prepares it in the
  launch context and honors a custom `--user-data-dir`.
- A native Linux target in WSL uses Linux paths. If no desktop executable is available, account
  collection may prepare the host's native default profile. Target conflicts and process-query
  failures remain errors.

Initialization creates only a missing `storage.json`, using generated device identifiers in both
the flat and nested telemetry formats. It validates an existing file and preserves its bytes.
Malformed JSON, non-object content, and filesystem failures are reported instead of replacing the
file. Atomic exclusive publication preserves a file created concurrently by another process.

The adjacent `state.vscdb` is created only by an existing identity write or credential injection
when needed. Initialization does not create authentication records or modify the newer Hub's
`app_storage.json`.

## Read and failure behavior

Read-only identity queries do not create files, and CLI account switching does not initialize
desktop identity storage. If initialization fails during switch preflight, the running client and
its credentials remain unchanged. Failures after process shutdown are reported explicitly and do
not trigger an automatic second launch. Follow the [account switching acceptance tutorial](../antigravity-runtime/account-switch-acceptance.md)
for CLI and Electron evidence.

Classic terms acceptance is separate from device identity profiles; see the
[security reference](../../security.md#classic-terms-state) and the acceptance tutorial above.

The focused [identity-profile storage tests](../../../src/tests/unit/identity-profile-storage.test.ts)
cover storage initialization and preservation behavior. Use the central
[testing strategy](../../testing.md) to select evidence for broader changes.

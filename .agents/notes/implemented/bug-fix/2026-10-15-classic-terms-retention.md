# Agent Note: Classic terms retention

Status: implemented

## Problem

Official Classic 2.23.0 stores one last accepted account and standard/GCP type in app_storage.json.
Switching accounts replaces the slot, so returning to a previously accepted account can show the
same dialog again. The official writer is asynchronous; visible dismissal does not prove durable
storage, and a close can lose a recently observed record. The initial regression drives the real
switch flow over actual fixture files and fails with B still recorded after switching back to A.

## Decision

The runtime owns a bounded per-profile history, using account digests and observed type values.
Windows credential-store Classic switches capture before normal close and reread after exit.
Both cloud accounts and local snapshots supply the selected identity. After credential injection,
only the consent fields are merged for an account with an actual observed record. No acceptance
button is automated. The official client still detects a changed standard/GCP requirement.

History is bound to canonical profile and executable metadata plus product/build version.
A new revision or invalid history first removes stale consent, then commits an empty history for
that revision. A valid baseline saves observed records before replacing its single slot. Failed
writes abort launch; prelaunch rollback changes only fields still belonging to this operation.
Once launch is attempted, the flow does not rewrite a possibly running client's file. Existing
credential failures and partial completion semantics remain unchanged.

The first baseline adopts existing official state; it cannot date that state against an older
client version. Exact legal terms revisions are unavailable in this format. Requiring every user
to repeat initial consent before adopting an existing same-version record was not selected.
Native macOS, Linux, WSL, IDE and Agy behavior is outside this Windows Classic implementation.

## Alternatives considered

- A fixed accepted flag or synthetic username would fabricate first consent and miss type changes.
- Copying entire official profiles would overwrite unrelated settings and could include credentials.
- Per-account full client profiles would change workspace, history and launch behavior.
- Restoring across installation revisions would reuse consent after an update without evidence.
- An asynchronous generic cache that swallows durable errors could lose the only remaining record.

## Consequences

Previously accepted accounts can switch without repeatedly replacing each other's local consent.
The history is an additional bounded, local pseudonymous durable file; no existing database schema,
credential location or public IPC contract changes. New/invalid versions require manual confirmation.
External application launches can still race the owner's process/file checks; the official client
does not cooperate with a Manager lock. Unknown client versions disable retention rather than guess.

## Verification

- The original file-level A-B-A test failed against the previous implementation.
- Focused switch, cloud/local owner, credential write and guard tests passed (73 tests across seven suites).
- Final type checking, scoped lint and formatting passed.

- The Windows x64 application package completed with native preparation and bundled dependency checks.
- Agent contracts passed. The repository-wide read-only formatting check reports 2,098 existing warnings; all 11 files in this change pass the scoped check.
- Packaging used the verified official Node distribution cache; a fresh uncached download was not established.

- Both packaged CLI and Electron owners passed real Windows Classic 2.23.0 B-A-B-A-B switching. Each owner passed three restarts for A and three for B: ten live Google identity checks and twelve restarts in total. Every switch confirmed visible official identity and matching durable consent; every restart also verified the durable record after normal shutdown. No additional consent was requested after the initial manual confirmation.
- Each owner confirmed client shutdown and byte/metadata restoration of the original Windows credential. The runner restored Windows login settings and the original isolated automatic-update preference.
- The first CLI attempt was interrupted after the official client downloaded 2.23.1 and attempted automatic installation on quit during manual-consent setup. Its failed report is preserved. The configured installed executable remained 2.23.0; the successful runs temporarily disabled the official per-profile automatic-update check. This controls updater interference without patching the official binary.
- Native macOS, Linux and WSL were not exercised for this Windows-only retention change. Their no-op paths are covered by focused tests.

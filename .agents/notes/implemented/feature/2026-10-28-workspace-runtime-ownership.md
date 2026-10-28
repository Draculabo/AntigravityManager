# Agent Note: Workspace credential and process ownership

Status: implemented

## Problem

Independent IDE profiles must not share a credential destination or select a peer's process tree.
A version-based Windows IDE credential redirection would make separate data directories write
the same standalone-client system credential. Workspace provisioning also occurred before process
operation ownership, allowing rejected operations to mutate credentials. Deletion could continue
after failed process observation or shutdown.

## Decision

Keep desktop IDE OAuth in its captured profile's SQLite UnifiedStateSync state, including Windows
IDE 2.6. Use the existing prepared writer and transactional recovery backup. Do not create a
standalone HOME token mirror or accepted-terms records for desktop workspace startup. Keep the
[prepared-storage decision](../architecture/2026-10-02-prepared-client-account-storage.md)'s other
snapshot and Classic obligations.

Acquire profile operation ownership before fresh process observation or provisioning. Re-read
profile existence and binding under that lock. Preserve primary-versus-profile process scope
through preparation, service replacement, start confirmation and captured-tree cleanup. Exclude
only positively identified managed peers from ordinary IDE discovery; keep unknown-owner and
installation conflicts. Hold the same lease through stopped-state deletion and report partial
filesystem effects without discarding the profile record on cleanup failure.

Retain the existing Forge native rebuild and isolated standalone dependency tree. Remove the
custom shared-dependency patch/rebuild hook whose fixed Electron and Node ABIs do not match this
repository's runtime versions. Workspace tests use the existing portable Vitest selection.

## Alternatives considered

- Serialize writes to one OS credential: prevents overlapping writes but cannot provide persistent
  simultaneous account isolation.
- Set HOME or disable a Linux secret-service address as proof of Windows credential isolation:
  neither changes the Windows vault target.
- Relax every process-directory conflict: can close an unknown installation or write live state.
- Infer authoritative credentials from one successful write or a mismatch between stores:
  neither establishes official-client consumption.
- Treat failed observation or stop as permission to delete: risks removing a running client's data.
- Rebuild native dependencies in place for fixed unrelated runtime versions: changes shared
  development dependencies and bypasses the established standalone boundary.

## Consequences

Workspace account credentials and process ownership are profile-scoped; customization sharing
remains intentional and does not provide OS-user security isolation. Classic keeps its existing
single hot attempt, full restart fallback and closed diagnostic timeline. Workspace launch does
not retry an uncertain dispatch. No existing client credential format or workspace row is migrated.

Directory cleanup can partially succeed before failing. Metadata is retained on cleanup failure;
if metadata deletion fails after cleanup, its record remains with an absent directory. Errors
propagate, and code rollback cannot recover removed files. Current behavior and recovery are in
the [workspace runtime reference](../../../../docs/modules/workspace/runtime.md).

## Verification

The inspected official Windows IDE executable reports version 2.6.0 and SHA-256
`df765a8ae84a673ae9e8c8e60eca8e7e839351029c58803a107b8f010ce7b736`.
Its active `resources/app/out/main.js` connects desktop OAuth subscription and renewal events to
`uss-oauth`, whose lifecycle reads and persists `antigravityUnifiedStateSync.oauthToken` through
application storage. Application storage resolves to the selected data directory's default
profile database. The extension's HOME token-file fallback belongs to its CDE authentication path;
it is not evidence of a desktop system-keyring transition.

Isolated Windows A/B investigation seeded separate databases with invalid expired access tokens
and authorized refresh tokens, without HOME standalone-token files. Both official clients recorded
fresh signed-in transitions. After confirmed exit flushed provider state, each database contained
the matching provider-populated account status rather than its seeded minimal record. A restarted
while B remained alive and signed in. The exact shared Windows credential was unchanged and its
in-memory recovery snapshot was verified; owned processes exited. Reports omit account identities
and token values.

The inspected client did not persist renewed short-lived access tokens into the original OAuth
row. Provider-populated identity after flush and fresh login are recorded separately from that
negative observation. Concurrent AI generation, new first-run consent, macOS, physical Linux and
future official releases remain outside this Windows investigation.

Focused regressions cover primary discovery, explicit workspace directories, unknown owners,
peer-preserving hot-service and forced-close checks, operation locks, deletion and Classic
recovery diagnostics. The native client-account integration script verifies real SQLite isolation,
backups, transaction failure and unchanged namespaced Windows credentials under Electron. This
does not substitute for packaging or live-provider generation acceptance.

# Upgrade guide: Re-select and verify the IDE account

Target version: next

## Affected users

Windows, Linux and macOS IDE 2.6 or newer users switching ordinary accounts, including users restoring local account
snapshots. Previous builds can update only desktop SQLite or only the embedded Agent's system
credential. The ordinary switch now synchronizes both and the standalone fallback, then confirms
the embedded Agent identity. Linux product discovery now uses `ideVersion` rather than the VS Code
engine version. Mac uses the Keychain and credential files described below. Older IDEs retain their destination behavior.
Workspace rows and account snapshot formats remain readable; simultaneous workspace account
isolation is not resolved by this upgrade.

## Required action

1. Save work and stop official IDE/App clients before replacing the Manager build.
   Before moving older accounts to another machine, run the updated Manager on the source machine
   and load its local account list while the original keyring is available. Registered encrypted
   snapshots are decrypted, validated and atomically rewritten as portable JSON. Check migration
   result logs for failed account IDs before copying; failed files remain intact.
2. Select the intended ordinary IDE account again. No account is inferred or migrated automatically
   from another client's credential. Historical encrypted backups still require their original key.
3. Confirm the official client account. The Manager also requires its restarted Agent to confirm
   the selected email before account finalization. Complete official notices manually if shown.
   A credential-update/identity-unconfirmed error requires checking the client before retrying.
4. Avoid relying on concurrent workspace profiles to retain different Agent accounts on
   IDE 2.6; they share a native credential even when their desktop data directories differ.

## Data and recovery

An existing database receives its WAL-aware `.account-switch.backup`. Windows IDE ordinary switches
also save a plaintext JSON `.account-switch.credentials.backup` sibling before changing client state.
It captures the shared native credential and standalone file after shutdown, including absent
destinations. Keep both matching files private. New records do not need a Manager key. The next switch
replaces these recovery files. No account rows or snapshots are converted eagerly.

Account snapshot migration keeps a separate permanent pair of backups before replacing ciphertext:
`<snapshot>.migration-backups/<original-ciphertext-sha256>/encrypted.snapshot` preserves the original
encrypted bytes and `decrypted.json` preserves the complete decoded JSON. Both copies must pass
readback before replacement. History is retained across later migrations and account deletion;
existing backup files are verified rather than overwritten. A backup or final replacement failure
leaves the current snapshot intact and reports incomplete migration. Completed copies remain.

To recover a snapshot, stop Manager/Core and preserve its current file first. Copy the selected
`decrypted.json` into the original snapshot path referenced by the account index. It can be read
without the original machine key. The encrypted copy can be restored in the same way when its
original key is available. Use working copies; keep the migration-history files unchanged.
These sibling backups do not protect against deleting or losing the whole profile directory.

For manual recovery, close every official IDE/App first and preserve the current profile database,
WAL and SHM together in a private recovery directory. Restore only the matching, completed online
SQLite backup; do not combine it with the displaced WAL. Invoke the trusted runtime's
`restoreWindowsIdeCredentials` with the selected profile's `PathResolutionOptions` to restore the
native item and standalone file. This API is exported by `antigravity-runtime` for a trusted
maintenance caller and is not exposed through renderer IPC. Stop the Manager/Core owner before
using a separate maintenance process. The API verifies restored bytes/metadata,
refuses running desktop clients and leaves the backup files intact. Restart once and verify both
desktop and Agent accounts. Recovery across stores is not atomic: preserve files and diagnose any
reported restoration failure before restarting. A failed SQLite backup does not authorize restoring
an older recovery copy from a previous switch.

Linux uses `.account-switch.linux-credentials.backup` and the trusted `restoreLinuxIdeCredentials`
API for the same stopped-owner recovery procedure. It preserves every matching Secret Service
item's original bytes/content type and standalone bytes or absence. Existing labels/attributes
remain in place. An original item that was removed or acquired a different provider object path
cannot be reconstructed by this API; recovery refuses before native mutation. Keep its original
Secret Service environment. Historical encrypted records require the original Manager key. See [Linux recovery](../../modules/antigravity-runtime/security.md#linux-ide-26-recovery).

Mac IDE 2.6 ordinary switches now synchronize SQLite, Keychain and standalone/Google caches using
the Mac credential format. Save work, close other official clients and select the intended IDE
account again after upgrading. The restarted Agent must confirm that account before the Manager
finalizes it. Native/file mirror errors remain best effort, and the dedicated Agy
session is not rewritten. These shared credentials do not isolate concurrent workspace accounts.

Mac receives the SQLite `.account-switch.backup` but does not have the Windows/Linux native
native recovery API. Its existing Keychain delete/create sequence can lose the previous item if
creation fails. Preserve the original account's ability to sign in through the official client;
if credentials are lost, sign in there again. Restoring SQLite alone does not restore Keychain or
the shared credential files. No native Mac recovery or downgrade trial has been performed.

Workspace deletion now stops after an observation, close or cleanup failure. Partial directory
cleanup retains the profile record and reports failure; removed files are not reconstructed.
A database-record deletion failure after successful cleanup also reports a partial effect.
Keep a separate backup of any workspace history that must survive deletion.

## Downgrade

Database and snapshot schemas are unchanged. New account snapshots and native recovery records
are plaintext JSON, independent of a machine-bound key. Historical encrypted snapshots migrate
when the original machine loads its local account list or reads a selected snapshot. Decryption,
validation or replacement failure retains the original file; listing continues with a failed
count, while selecting that snapshot reports failure. List-time migration waits for prior account
writes. A concurrently replaced or deleted file is not overwritten or recreated. Load the account
list or capture the account on the original machine before transfer; if its key is lost, sign in again.
Copy the snapshot and update its account-index path on the destination machine; native recovery
records remain restricted to their original OS credential environment and are not account exports.
Older builds may not support the current native recovery record and can leave desktop/Agent
identities inconsistent again. Stop clients
and preserve or restore the required credential sources before downgrading. Reverting code does
not restore prior account state or deleted workspace files. A live downgrade has not been tested.

## Verification

Focused tests verify ordinary/workspace routing, required write failures, identity mismatch/timeout,
success finalization, portable account snapshots and JSON file restoration. Native Windows Electron checks verify exact
credential recovery on a namespaced target. The Windows IDE 2.6 CLI/Core matrix passes cloud/local
A-B-A plus cold restart with desktop, Google and Agent identity checks, followed by exact shared
credential restoration. This does not establish concurrent workspace accounts, generation success,
macOS or physical Linux acceptance. See the [acceptance guide](../../modules/antigravity-runtime/account-switch-acceptance.md)
for the current matrix and its evidence limits.

The real recovery API also restores the native item's exact payload/metadata and the standalone
file's exact bytes, with a consistent readable SQLite backup checked separately. Electron's
final live matrix also passes all seven cloud/local/cold-restart checks using a static renderer
and the real renderer IPC transport. Earlier official-window observations stalled; the runner
now aborts stalled IPC/identity observations at an outer deadline and preserves failed outcomes.
The successful matrix does not identify the cause of those intermittent automation stalls.

Mac IDE fixtures compare Keychain arguments, complete payload and isolated cache
files, plus version routing and restart identity finalization. The maintainer explicitly accepts
release without native Mac acceptance; Keychain prompts, Launch Services and live Mac A-B-A/AI
requests remain unverified. See [Mac IDE testing](../../modules/antigravity-runtime/testing.md#mac-ide-26-credential-compatibility).

See [runtime ownership](../../modules/workspace/runtime.md) and the
[decision and evidence](../../../.agents/notes/implemented/feature/2026-10-28-workspace-runtime-ownership.md).

# Agent Note: Prepared client account storage and portable local snapshots

Status: implemented

## Problem

Account switching previously combined storage-format guessing, historical state replay and writes to multiple database candidates. A recovery-copy write could mask primary-store failure. Local snapshot parsing happened too late to prevent an unnecessary shutdown. Machine-bound snapshot encryption also prevents transferring account files to a second machine without the original key; the maintainer reports a prior user incident with this failure mode.

## Decision

The runtime owns client credential adapters and a prepared account writer. Account and cloud-account features own account selection and snapshot decoding. Preparation freezes credentials and the selected installation/profile before the switch changes client state. Older IDE and pre-version-2 Classic write UnifiedStateSync. Ordinary Windows and Linux IDE 2.6 switches synchronize profile-local desktop OAuth plus the embedded Agent's shared system credential and standalone fallback. Current Classic uses system credentials; explicit CLI switching uses its existing environment-local session files. Unknown Classic versions use an existing selected-installation database, otherwise credentials. Windows version discovery uses asynchronous PE resource queries through existing Koffi.

The Windows IDE decision is revised after inspecting both official 2.6 desktop OAuth and its embedded agy backend, then observing Agent `GetAuthStatus`/`GetUserStatus` under controlled accounts. Desktop SQLite success alone does not establish the Agent account. The ordinary switch therefore closes the captured tree, saves native/file recovery state as private plaintext JSON, writes required destinations, restarts once and confirms the selected Agent identity before finalizing account metadata. Native attributes that cannot be restored prevent mutation. Required write/readback or identity failure remains a partial or unconfirmed switch, without automatic cross-store rollback. Recovery is explicit with clients stopped; its exact scope is in the [security reference](../../../../docs/modules/antigravity-runtime/security.md#windows-classic-credential-storage).

SQLite writes preserve unrelated OAuth rows, replace account identity, clear an absent enterprise project, delete obsolete account caches, and verify writes in one transaction. One online backup captures the pre-write state including WAL; backup existence cannot turn a failed primary write into success. Native writes require token readback. Explicit CLI switches fail when required local credential files fail, even if system credentials were already updated.

On 2026-11-04, the maintainer explicitly selects portable plaintext JSON for new account snapshots and native recovery records. This replaces the encryption decision in this record. New writes and plaintext reads do not initialize encryption or access the keyring. The version 1.0 account envelope is unchanged, and the existing atomic private-file writer retains restrictive permissions. Local-account listing migrates registered encrypted snapshots using their original key; selected reads also migrate after successful decryption and schema validation. Migration retains the exact decoded JSON, including fields outside the current projected type. Historical JSON and jetski token input remain readable and are normalized instead of replayed. Native snapshots serialize into existing UnifiedStateSync fields. No new secret store is introduced.

Listing now participates in the local owner's write queue so migration cannot overlap capture,
switching or deletion in that owner. Immediately before synchronous atomic replacement, the reader
compares the current file with the original ciphertext. A newer capture is refused, a deleted file
is not recreated, and another completed migration to the same plaintext is accepted. A list-time
failure logs only a sanitized account ID, retains that file and continues other accounts; aggregate
logs report migrated and failed counts. Selected reads propagate failure before client shutdown.
External account discovery remains read-only; it does not rewrite discovered source profiles.

The maintainer also requires both representations to survive migration. Before replacing the active
file, preserve exact ciphertext and decoded JSON in a sibling migration-history directory. The
SHA-256 of the original ciphertext identifies a version, avoiding timestamp collisions and duplicate
copies on retry while retaining different original versions. Both files use the existing atomic
private-file writer and must pass byte readback before replacement. Existing history must match;
it is never overwritten or automatically pruned, including during ordinary account deletion.
Backup failure aborts migration without changing the active file; completed copies remain usable.
This history is local to the snapshot filesystem and does not establish off-device durability.

Linux IDE 2.6 extends the ordinary-switch decision after WSL reproduced successful SQLite B writes
with the restarted Agent still on A. Linux synchronizes SQLite, keyring and fallback credentials.
Linux discovery must use `product.json`'s `ideVersion`; its package
version is the separate VS Code engine release. Required live acceptance explicitly demands Agent
identity independently of the destination selector, so an incorrect version route cannot hide
this failure again.

Linux IDE credentials use system libsecret through the existing Koffi dependency. The existing
keyring binding searches all collections but cannot identify/recover duplicate matching items
separately. Updating matching items in place preserves labels, attributes and collection ownership;
the JSON recovery record retains each original item path, bytes and content type. Missing
original items are refused rather than recreated in a guessed collection. An empty store creates
one default item. This avoids creating redundant collections, preserves divergent original values
for recovery and makes every required write/readback explicit. Locked items fail preflight; native
calls use GCancellable with one ten-second operation deadline. GLib libraries remain loaded for
their registered types' process lifetime. Windows retains its existing codec and recovery API.

Linux workspace provisioning retains SQLite and does not inherit ordinary-switch synchronization.
Shared Secret Service credentials still prevent assuming simultaneous account isolation.

Linux process observation uses `/proc/<pid>/stat` field 22 as the boot-relative creation identity,
instead of the native binding's epoch estimate. WSL live acceptance captured the same PID and
kernel creation ticks while its reported epoch start changed by three seconds. The previous
identity guard then rejected the same live IDE as replaced. No clock-drift tolerance or PID-only
match is introduced: creation ticks still detect PID reuse and order process ancestry. Zombie/dead
rows and vanished proc entries are omitted; malformed or inaccessible proc data fails the query.
An unreaped IDE row with state `Z` also explained an earlier metadata-unreadable rejection.

## Alternatives considered

- Keeping fallback writes that hide primary-store failure preserves ambiguous success and stale account state.
- Replaying every snapshot field couples restores to obsolete client internals and can reuse another account's project.
- Repeated shell or application version probes can block switching or launch a GUI.
- Encrypting new snapshots with a machine-bound Manager key blocks account transfer. Rejected after the reported cross-machine import incident; plaintext JSON with private permissions is the selected trade-off.
- Per-switch online AI requests conflate local switching with network, provider and quota failures.
- Use only SQLite for Windows IDE 2.6. Rejected after Agent identity observations showed that desktop OAuth and embedded Agent authentication have separate readers.
- Use only the native item. Rejected because desktop OAuth and a stale standalone fallback would remain unsynchronized.
- Copy generic Gemini OAuth caches during an IDE switch. Rejected because those files belong to explicit CLI switching.
- Automatically roll back every store after uncertain startup. Rejected because a running client can refresh credentials or write state; manual recovery retains the original protected inputs without overwriting a live writer.

## Consequences

Historical account snapshots migrate when listed or selected on their original machine; unrelated encrypted data and external discovery sources remain untouched. New JSON snapshots transfer between machines without the original Manager key; anyone who can read the file can read its tokens. Load the updated local account list before transfer while the original key remains available, or capture the account again. Missing or invalid historical keys leave the old file unchanged and produce incomplete-migration logs; selected reads fail before shutdown. Native recovery records are not portable account exports: their original HOME, OS metadata and Secret Service object paths remain validated. Code rollback does not restore account or credential state.

The client-owned SQLite database, its recovery backup, and official OAuth caches remain client-readable interoperability files. Recovery requires the client to be stopped and database/WAL consistency to be respected. SQLite account writes are transactional; keyring and multiple client-file writes cannot be atomic together. Later failure reports partial completion without success metadata. Process confirmation remains separate from real account identity and AI-request acceptance.

Windows IDE 2.6 native credentials are shared with other clients. This change addresses ordinary switching only; it does not establish simultaneous per-workspace Agent accounts. Workspace callers explicitly retain their existing prepared-writer behavior instead of inheriting the ordinary switch's additional file/SQLite writes. The [workspace ownership decision](../feature/2026-10-28-workspace-runtime-ownership.md) retains process, deletion and customization obligations. Other platforms, old IDEs, Classic and CLI routing remain independent.

## Verification

Focused tests cover storage routing, frozen credentials and destinations, project clearing, unrelated-row preservation, rollback, native readback, required CLI failures, portable JSON, historical encrypted input and discovery. The cross-machine fixture first fails against the encrypted writer, then copies a new snapshot from an A directory to a B directory with a different unavailable key and verifies complete read and credential discovery. The isolated client-account integration script verifies real SQLite WAL backups, A-to-B-to-A restoration and peer profile preservation. Separate Windows IDE 2.6 inspection and isolated A/B checks establish the profile-local desktop OAuth path; see the workspace decision for the precise evidence and limits. Synthetic checks do not establish macOS acceptance or real AI readiness. See the current testing reference for release acceptance requirements.

The Windows IDE follow-up adds negative controls for missing SQLite synchronization and premature success finalization, loopback Agent identity fixtures, JSON file recovery and namespaced native item restoration. The recovery fixtures verify that plain records do not access a master key and that historical encrypted records still read with the original key. Live evidence must separately identify desktop, Google and Agent observations and exact cleanup; the [acceptance procedure](../../../../docs/modules/antigravity-runtime/account-switch-acceptance.md) owns those checks. Provider task generation and simultaneous workspace isolation are outside the ordinary-switch acceptance claim.

Migration tests first fail against the read-only ciphertext reader. They then cover automatic
plaintext persistence, all-field preservation, idempotence without the old key, incomplete batches,
failed replacement/decryption/schema validation, and newer/deleted files while decryption is held
at a controlled barrier. Owner tests establish list/write serialization and unchanged account-index
bytes during mixed-success migration.

Dual-backup tests verify pre-replacement ordering, exact data including unknown fields, retained
versions, partial backup failure/retry, mismatched history, byte readback and redirected-directory
refusal. Both encrypted and plaintext backup copies are exercised through restoration to the active
path; plaintext restoration does not initialize encryption. An isolated mutation omitting backup
preservation fails the required pre-replacement assertion before the unchanged source passes.

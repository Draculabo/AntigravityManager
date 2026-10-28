# Agent Note: Prepared client account storage and encrypted local snapshots

Status: implemented

## Problem

Account switching previously combined storage-format guessing, historical state replay and writes to multiple database candidates. A recovery-copy write could mask primary-store failure. Local snapshot parsing happened too late to prevent an unnecessary shutdown. Native credentials also need a snapshot format without adding plaintext Manager secrets.

## Decision

The runtime owns client credential adapters and a prepared account writer. Account and cloud-account features own account selection and snapshot decoding. Preparation freezes credentials and one selected destination before the switch changes client state. IDE and pre-version-2 Classic write UnifiedStateSync. IDE 2.6 retains its profile-local SQLite OAuth lifecycle; a standalone-client version number does not establish an IDE credential-store transition. Current Classic uses system credentials; explicit CLI switching uses its existing environment-local session files. Unknown Classic versions use an existing selected-installation database, otherwise credentials. Windows version discovery uses asynchronous PE resource queries through existing Koffi.

SQLite writes preserve unrelated OAuth rows, replace account identity, clear an absent enterprise project, delete obsolete account caches, and verify writes in one transaction. One online backup captures the pre-write state including WAL; backup existence cannot turn a failed primary write into success. Native writes require token readback. Explicit CLI switches fail when required local credential files fail, even if system credentials were already updated.

New local snapshot files encrypt the existing version 1.0 envelope using the Manager master key and existing versioned ciphertext format. Historical JSON and jetski token input remain readable; they are normalized instead of replayed. Native snapshots serialize into existing UnifiedStateSync fields. No schema migration, eager rewrite or new secret store is introduced.

## Alternatives considered

- Keeping old-format or dual writes preserves ambiguous success and stale account state.
- Replaying every snapshot field couples restores to obsolete client internals and can reuse another account's project.
- Repeated shell or application version probes can block switching or launch a GUI.
- Plaintext native-token snapshot fields add a new credential exposure and unnecessary durable format.
- Per-switch online AI requests conflate local switching with network, provider and quota failures.
- Redirecting Windows IDE 2.6 to the standalone system credential conflates independent products. A mismatch between two stores does not establish which store an IDE reads. Active official-client OAuth lifecycle code and isolated provider identity are required before changing authority.
- Writing both SQLite and the system credential duplicates authorities and adds non-atomic partial writes; one target-owned primary store is used instead.

## Consequences

Historical snapshots remain untouched until a new capture replaces them. New encrypted files depend on the original Manager master key; copying a snapshot alone does not migrate an account. Preserve old backups and the original keyring. Rollback to an older JSON-only reader requires recapture or explicit decryption with the current reader and original key. Missing or invalid keys fail before shutdown rather than discarding recoverable data.

The client-owned SQLite database, its recovery backup, and official OAuth caches remain client-readable interoperability files. Recovery requires the client to be stopped and database/WAL consistency to be respected. SQLite account writes are transactional; keyring and multiple client-file writes cannot be atomic together. Later failure reports partial completion without success metadata. Process confirmation remains separate from real account identity and AI-request acceptance.

IDE switches preserve other clients' system credentials. Workspace launches use their captured profile directory and executable in the same prepared writer. The [workspace ownership decision](../feature/2026-10-28-workspace-runtime-ownership.md) records the official IDE 2.6 evidence and concurrency boundaries. This corrects the earlier inference from a database/system-store mismatch without rewriting existing profiles or standalone credentials.

## Verification

Focused tests cover storage routing, frozen credentials and destinations, project clearing, unrelated-row preservation, rollback, native readback, required CLI failures, encryption, historical input and discovery. The isolated client-account integration script verifies real SQLite WAL backups, A-to-B-to-A restoration and peer profile preservation. Separate Windows IDE 2.6 inspection and isolated A/B checks establish the profile-local desktop OAuth path; see the workspace decision for the precise evidence and limits. Synthetic checks do not establish macOS acceptance or real AI readiness. See the current testing reference for release acceptance requirements.

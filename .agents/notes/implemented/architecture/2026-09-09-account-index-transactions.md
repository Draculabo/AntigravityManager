# Agent Note: Serialize account-index transactions

Status: implemented

## Problem

Account operations independently load and save the complete JSON account index. A local account switch keeps that snapshot across process shutdown, credential or database restoration, identity application, and process restart. A concurrent account update can commit during that interval and then be overwritten by the stale switch snapshot. The existing rename fallback also copies a temporary file directly over the durable target, so a failed fallback can partially replace the last valid index.

## Decision

The account module owns one process-local serialization gate per resolved index path. `readAccountIndex` returns a detached, schema-validated snapshot through the gate. `mutateAccountIndex` loads and validates the latest index, provides a transaction-owned draft to a synchronous non-reentrant callback, validates the complete result, writes it through the shared same-directory UUID temporary-file helper, and returns a detached callback result. The helper synchronizes the temporary file before replacement and synchronizes the parent directory after replacement on POSIX. Windows retains file synchronization and replacement but deliberately skips directory synchronization.

Account business operations keep database, credential, identity, process, and other external work outside the mutation callback. Switch completion opens a fresh transaction, treats deletion as final, advances `last_used` without regression, and conditionally persists a generated identity only when the latest identity fields still equal the switch's starting snapshot.

## Alternatives considered

- Lock writes but allow reads and read-modify-write preparation outside the gate. Rejected because stale snapshots can still overwrite newer mutations.
- Reuse the process switch guard. Rejected because account metadata and identity mutations do not all belong to the process-switch lifecycle, and holding that guard would not define a persistence transaction.
- Add a cross-process file lock. Rejected because current account-index writers live in one Electron main process and no cross-process writer has been demonstrated.
- Recover a valid JSON prefix from a malformed index. Rejected because guessing a partial durable state can silently discard accounts; malformed persisted data remains fail-closed.
- Copy a temporary file over the target after rename failure. Rejected because direct copying can truncate or partially overwrite the last committed target.
- Continue without file synchronization. Rejected after the durable-write boundary was introduced: configuration, OpenCode state, and the account index now share one file-syncing temporary-write contract. The parent-directory sync remains POSIX-only; Windows behavior is separately exercised by target-replacement tests.

## Consequences

- Reads now queue behind active mutations, and all account-index read-modify-write paths serialize through one owner.
- Callers must split workflows into a short read, external work, and a short mutation against the latest state.
- Malformed stored data remains fail-closed. A failed temporary write or replacement leaves the last committed target unchanged.
- Switch completion can succeed after concurrent deletion without recreating the account. Concurrent account and identity edits remain authoritative unless the relevant identity snapshot is unchanged.
- The gate remains process-local and does not coordinate with external writers. Its persistence path now provides file synchronization before replacement and POSIX directory synchronization after replacement; it does not claim filesystem, controller, or hardware behavior beyond those operations.

## Verification

- `src/tests/unit/account-index-store.test.ts` covers detached boundaries, synchronous callbacks, reentry, serialized mutations, schema validation, callback/write/replacement/cleanup failures, UUID temporary paths, file synchronization, and replacement of an existing target on the real filesystem. This test passed in the primary Windows environment with `process.platform` reported as `win32`.
- `src/tests/unit/account.test.ts` covers switch interleaving with concurrent account/identity mutation, non-regressing `last_used`, concurrent deletion, and generated identity persistence when the starting snapshot is unchanged.
- Focused tests, type checking, type-boundary verification, focused ESLint, Agent Note validation, and diff whitespace validation pass for the batch-owned files.
- Repository-wide governance and formatting remain separately blocked by pre-existing, non-batch worktree findings; those files are not changed by this decision.

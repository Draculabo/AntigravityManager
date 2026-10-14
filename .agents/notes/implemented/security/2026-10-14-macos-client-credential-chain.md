# Agent Note: macOS client credential installation contract

Status: implemented

## Problem

[Issue 351](https://github.com/Draculabo/AntigravityManager/issues/351) requires validating
the complete Mac client installation contract. Changing command transport alone leaves
differences in ID-token placement, access flags, local mirrors, database injection and
confirmation that can invalidate a client compatibility trial.

This decision supersedes the [previous transport decision](2026-10-13-macos-client-credentials.md).

## Decision

Keep Mac installation in dedicated credential modules shared by both process owners.
Use the complete client sequence described in [security](../../../../docs/security.md):
delete/create Keychain commands through PATH, explicit complete password argument, root
ID token, three direct file mirrors, sequential SQLite writes and refresh-token-only Agy
confirmation. Native Classic writes have no readback gate. Existing client databases allow
nonfatal fallback after Keychain failure, including a failed fallback injection.

Use the shared `ItemTable` schema and Drizzle query builders for client database access.
Existing keys use `onConflictDoUpdate` to update their values; connection closure remains
owned by the native handle. Keep each statement independently committed rather than
introducing a transaction, so later failures retain the preceding writes.

Apply the native Mac identity profile after credentials, with best-effort failure handling.
Reassert credentials after supervised service termination as a best-effort operation;
failed replacement confirmation selects the existing restart path without another
installation attempt. Preserve the shared process owner's
installation capture, process selection and user-closed-window checks.

## Alternatives considered

- Updating the old Keychain item with `-U` preserves its previous value on failure but
  changes creation and access behavior, preventing verification of the complete contract.
- Full-field readback and transactional injection strengthen confirmation but introduce
  additional failure gates and different partial-write behavior.
- Maintaining two selectable Mac installation modes makes an internal compatibility trial
  ambiguous and duplicates credential policy. One current Mac implementation is sufficient.

## Consequences

Deletion can remove the previous credential before a failed creation. `-A` broadens access
to the item. Command arguments temporarily expose the encoded credential to permitted
process observers. Commands have no explicit timeout, so an access prompt may block a switch.
Mirrors and SQLite statements can partially succeed; `.backup` copies are best effort and
do not establish WAL consistency. Success is not proof of official-client account identity.
The new payload and mirror locations are existing client contracts, not Manager database
schema changes. Windows and Linux retain their existing installation policies.

Physical Mac acceptance is the release gate for this behavior. A failed trial requires
revisiting this decision and restoring the previous implementation together with its
tests and current documentation; do not add an implicit fallback to that implementation.

## Verification

The contract fixtures record expected command arguments, encoded payloads, file contents
and SQLite protobuf bytes. Complete fixture comparison uses isolated synthetic tokens
and a command recorder to verify the installation sequence and serialized data.
The new checks fail against the previous transport implementation.

Focused unit suites cover the Mac chain, switch ordering and existing Windows/Linux paths.
A final run passes 98 tests across 12 suites. Type checking, scoped ESLint and formatting,
agent-contract checks, and the existing `build:core` and `build:cli` scripts pass.
A real Electron SQLite check on Windows verifies expected bytes, preserved unrelated rows
and partial-write behavior after an injected failure. These checks never invoke live
Keychain commands or write real account credentials.

No physical Mac, native Keychain permissions or official-client login has been validated
in this environment. Acceptance requires two authorized accounts and A-B-A switches through
the CLI and Electron owners, with the actual client identity and a real AI request checked
after every switch. See [testing](../../../../docs/testing.md#client-credential-storage-checks).

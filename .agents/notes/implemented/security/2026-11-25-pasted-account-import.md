# Agent Note: Pasted account import

Status: implemented

## Problem

Users who already have a Google refresh token or a JSON export need to add those accounts without
signing in again. The Accounts page needs visible batch progress and a way to retry failures.

## Decision

The renderer accepts pasted credentials, removes identical entries, and sends one bounded refresh
token at a time through the dedicated cloud-account import operation. User-entered tokens pass
directly to the selected account owner. Desktop IPC audit skips this operation, private core RPC
rejects capture headers for it, and errors expose stable codes. The account owner verifies the
Google identity and writes the account through the existing credential store.

## Alternatives considered

- Encrypting each request would add key management to both owners. The account owner already
  receives the credential through its dedicated import operation.
- A single batch RPC would need a separate progress and retry contract spanning the renderer,
  Electron and the standalone core.

## Consequences

Refresh tokens are present in memory during the import request. Failed items remain available in
the open dialog for retry and successful items are released. Identity verification rejects a
different grant for an existing email unless the stored subject matches the verified subject.
This prevents importing an unrelated identity over a previously saved account.
Local discovery, file import, and IDE sync can update account metadata between verified imports.
Their account writes keep the stored subject proof only when the OAuth grant binding matches the
guarded current row.
This lets the account owner reuse its prior verification on a later pasted reauthorization while
keeping locally supplied credentials outside the verification boundary.

## Verification

The credential import, IPC audit, private core RPC and account dialog tests cover parsing,
rejection, account writes, capture exclusion and retrying only failed entries.
The SQLite import commit tests cover subject readback after local discovery and file import,
pasted reauthorization, and proof removal when the import changes the grant binding.

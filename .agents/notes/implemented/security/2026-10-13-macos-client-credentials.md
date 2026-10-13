# Agent Note: macOS official-client credential transport

Status: implemented

## Problem

System command transport replaces native macOS reads and truncated password prompt writes;
live macOS acceptance remains outstanding.

[Issue 351](https://github.com/Draculabo/AntigravityManager/issues/351) reports an invalid
native keyring target and password prompt writes truncated to 128 bytes. System `security`
reads address the credential by service and account; an explicit `-w` value bypasses the
password prompt limit. This transport requires accepting temporary command-argument exposure.

## Decision

Use the macOS system executable for both operations, preserving the current service, account,
payload encoding and complete readback verification. Update existing items with `-U` to
preserve the previous credential if replacement fails. Retain `-A` only for new items.
Reads and writes have ten-second subprocess bounds; reads have a 64 KiB output bound and keep
the existing decoder and typed errors. The item-not-found exit status returns null; other
command failures remain errors. Write errors contain a fixed message without the original
command, cause or output. Windows and Linux transport selection is unchanged.

Current behavior and exposure are described in [the security reference](../../../../docs/security.md).

## Alternatives considered

- Native keyring writes: the issue reports an application-signature failure. Switching to a
  native writer alone would not establish compatibility with the actual CLI and Electron hosts.
- Password prompt stdin: Apple Libc's `getpass` discards ASCII payload bytes beyond 128.
- `security -i`: avoids password prompt input but has a 4096-byte command buffer, imposing a
  different limit on long tokens and cannot carry the complete payload in the regression check.
- Delete and recreate on every switch: a failed replacement could lose the previous credential
  and would reapply the item's access policy. Updating the existing item avoids that failure.
- Weaker readback verification: does not explain or resolve the remaining mismatch reported
  in the issue, and could incorrectly confirm a switch.

## Consequences

The complete encoded credential enters a system process argument for the duration of the
write. This intentionally reverses the prompt-based transport introduced by the earlier
security change; error sanitization does not hide argv from authorized local process inspection.
Future removal requires a proven complete-data transport across the real supported macOS
runtime/signing contexts. No credential format, account repository or provider contract changes.

The remaining mismatch reported after the author's local fixes is not established as resolved
by this implementation. No successful process exit substitutes for complete readback.

## Verification

Before implementation, the long-token check observes 128 stored bytes and fails. The same
check subsequently round-trips a token exceeding 6000 bytes through the actual writer and
reader functions with mocked command transport, comparing all five returned credential fields.
Create/update command checks, bounded read failures, safe write errors, Windows writes, Linux
precedence and account write checks pass on Windows. These tests do not execute macOS Keychain.
Real CLI and packaged Electron A-to-B-to-A acceptance, keychain ACL behavior and client login
remain unverified without a macOS environment.

The wider security migration suite initially has three pre-existing Windows/CLI failures
whose assertions reference the old keytar/file-sync contract. A Git HEAD source override
reproduces the same failures. Inspection establishes that the obsolete keytar mock does not
isolate the current native Windows writer, and those initial runs overwrite the real target
with fixture credentials. The suite now mocks the owning Windows credential module, guards
against loading Koffi, and verifies the current exact-target and CLI-file separation contracts.
Restoration requires an independently identified credential source; no test fixture is a
valid recovery source. This isolation correction is necessary to run the affected suite safely.

Primary platform references:

- [Apple Security password parsing](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_add.c)
- [Apple Libc getpass manual](https://github.com/apple-oss-distributions/Libc/blob/main/gen/FreeBSD/getpass.3)
- [Apple Security interactive command buffer](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c)

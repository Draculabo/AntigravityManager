# Agent Note: Agy eligibility target matching and build diagnostics

Status: implemented

## Problem

[Issue #371](https://github.com/Draculabo/AntigravityManager/issues/371) reports that Manager
v0.26.0 rejects official Agy CLI 1.4.7 on Windows x64 with `PATTERN_NOT_FOUND`. The same core
matcher also rejects installed Windows x64 1.3.6. Synthetic tests pass because their byte arrays
contain the exact rule under test; they cannot establish real-build compatibility or its meaning.

Analysis of official CLI 1.1.2 locates the account eligibility check in `Manager.userInputLoop`.
The existing x86 signature instead matches `ServerBackend.SendSideQuestion.func2` in the Windows
build, referencing `stream ended prematurely`. NOPing that jump forces unrelated error handling.
The actual Windows 1.1.2 input-loop check reads `AuthStatus` fields inline, while 1.3.6/1.4.7
call `AuthStatus.EligibilityError`. Target selection therefore requires function identity and
control-flow evidence rather than a short byte signature.

The official 1.4.7 ZIP digest is
`b82fc615941c1ef1c0692186510e4f620004ee08017c9e94ec1ac61046b9cc66`;
its executable digest is `22588b6d5a6f6d2d66091c73dfb9255edc7bdafe9aff9dd20d958ce116496695`.
The installed 1.3.6 digest is `b8155654c01e7dd45eb15232722f905872d62e4424307d4e0ded4ee2687d4249`.
The core blob is identical in Manager v0.26.0 and the investigated checkout.

## Decision

Remove the global x86 signature. The x64 matcher parses bounded, non-overlapping PE/ELF PIE
section mappings and the Go 1.20+ pc/line table. It resolves exactly one named input loop and
eligibility-error function in the Go `.text` section. Auxiliary executable CRT sections do not
change the Windows Go text base. ELF section file/address mappings must agree with executable
load segments. Go's PIE `pcHeader.textStart` is zero in the inspected Linux binary; the Go
module-data text/etext fields are resolved through symbol-free `R_X86_64_RELATIVE` relocations.
The verified Go text base is 128 bytes into ELF `.text`. The parser requires unique module,
text and end relocations, checked numeric ranges and bounded section/segment/relocation tables.
Both image layouts feed one named-call and failure-block matcher. Unknown layouts fail closed.

Within that input loop, require `CALL EligibilityError; TEST RAX,RAX; JNE failure` and a
RIP-relative reference to `Eligibility Check` within the failure block. Replace only the
six-byte JNE, preserving the call, error function and other callers. The named functions, call
destination and failure UI reference prevent the demonstrated stream-error false positive.
The same scoped call/test with six NOPs establishes idempotence. Multiple candidate branches
are rejected; unfamiliar shapes are not relaxed. Existing ARM64 rules remain unchanged and
have a positive buffer-only baseline in official macOS ARM64 1.1.2.

Keep unmatched and ambiguous builds rejected before any backup or executable write. Preserve
the existing typed code and original matching error, adding the source SHA-256 and an explicit
preflight no-write outcome. Hash the bytes already read; do not execute the configured CLI to
obtain version information. Report no-write only in the preflight catch, not for later write,
verification or signing failures.

Keep [compatibility and evidence limits](../../../../docs/modules/antigravity-runtime/testing.md#agy-binary-patch-compatibility)
in the runtime testing reference and [user recovery](../../../../docs/upgrade-guides/next/agy-binary-patch.md)
in the upgrade guide. Windows 1.1.2's inline checks, x86 Mach-O and non-PIE ELF are not implemented.
Removing an unsafe match takes precedence over retaining synthetic cross-platform successes.

## Alternatives considered

- Match a shorter prefix or take the first candidate: rejected because unrelated instructions can
  match and a synthetic pass does not prove the target's meaning.
- Replace a newly discovered eligibility function with a success return: rejected because its
  other callers have separate failure responsibilities; only the TUI input-loop branch is in scope.
- Hardcode a file offset for each version: unnecessary for the inspected Windows and Linux builds;
  symbolic call relationships establish the actual target without assuming a fixed address.
- Assume the Go code begins at ELF `.text`: rejected because the Linux 1.4.7 text relocation
  points 128 bytes beyond the section start; the negative fixture enforces this distinction.
- Guess a compatible downgrade: rejected because no real positive compatibility evidence exists.
- Execute the configured file for diagnostic version detection: unnecessary; byte identity is
  sufficient for this failure report and avoids an additional external-process action.

## Consequences

Users can patch the investigated Windows and Linux builds without changing unrelated stream handling.
Older binaries that only matched the unsafe signature are rejected and may need restoration
from an exact-version original. Backup and signing behavior remains owned by the file service.
The source digest is diagnostic metadata, not an allowlist, integrity verification or permission to
patch. No credentials, account state or installed CLI is changed during acceptance. Actual live
conversation success remains distinct from successful local patching and startup.

## Verification

The new positive input-loop fixture failed with the old matcher; the old stream-error negative
fixture also failed because that matcher incorrectly accepted it. Both pass after replacement.
The focused suite covers wrong callers, callees and failure targets; malformed PE/Go ranges;
ambiguous branches and titles; auxiliary executable sections; unchanged input buffers;
idempotence; preserved backups; and injected macOS signing rollback.

Real Windows file-service acceptance uses independent executable copies and isolated profile
directories. It verifies exactly one six-byte change, an exact original backup, repeated-operation
idempotence, `--version` startup, byte-for-byte backup restoration, restored startup and cleanup.

| Build                 | Executable SHA-256                                                 | Branch file offset | Original bytes |
| --------------------- | ------------------------------------------------------------------ | ------------------ | -------------- |
| Windows x64 1.4.7     | `22588b6d5a6f6d2d66091c73dfb9255edc7bdafe9aff9dd20d958ce116496695` | `52228624`         | `0f85db200000` |
| Windows x64 1.3.6     | `b8155654c01e7dd45eb15232722f905872d62e4424307d4e0ded4ee2687d4249` | `48711344`         | `0f8596200000` |
| Linux x64 glibc 1.4.7 | `40349135371a8ed1f1af1e9f8b741de99174ae9fce6380b96c2d1f543480af7a` | `156204528`        | `0f85db200000` |

The official Windows 1.1.2 archive digest is
`f72e0b52ed582c4a44d6a88fb7d379902738fbaa6e8ecef2049e773eaf3e0796`; its executable
digest is `e6b17ac38e6f71346c197531c857b5925c6eca391a779e7f39c7d2d141535ca4`.
The unrelated old match starts at file offset `36112765`, corresponding to VA `0x14227157d`.

Official macOS ARM64 1.1.2 archive digest is
`50b760c50ff288342fd4bb8b1c21d5ac72da75dc47b6870b6fe645e9370c95ee`; executable
digest is `d9717b70b2f1c33db78e3f5758474e7e498e154b85201f21a5c5196742b3f031`.
Its buffer-only branch replacement is at `32093456`, from `070700b4` to `38000014`.
Mach-O sections and Go metadata place that match inside `Manager.userInputLoop`, whose
file range is `[32091392, 32100608)`; the ARM64 baseline is independent of the erroneous x86 match.
No native macOS execution, codesigning or real account conversation is established.

Official Linux x64 glibc 1.4.7 archive SHA-256 is
`67fd4e70be739b1f8b18f90b511da8cd2a7aef24e888e5837402e025bf7fdbfc`.
The Windows-only matcher and the new ELF regression fixture both failed with
`PATTERN_NOT_FOUND` before ELF support. Independent WSL `objdump` confirms the named call,
nil-error test, conditional jump and `Eligibility Check` reference in the failure block.
The fixture covers missing, ambiguous, symbol-dependent and invalid text relocations,
load-segment/section disagreement, malformed table bounds and unchanged inputs on rejection.

Native production file-service acceptance passes in WSL2 Ubuntu x64, glibc 2.35 and Node
24.22.0 using a separate Linux `/tmp` copy and isolated HOME/XDG paths. Original, patched and
restored `--version` output is `1.4.7`; only the intended six bytes change, mode `0751` remains,
the backup is exact and a repeated patch is a no-op. A mutated symbol is rejected without
modifying its bytes, existing backup or directory contents. The original source is unchanged
and the owned Linux directory is removed. Windows 1.4.7 and 1.3.6 file-service/startup/restoration
checks also pass after sharing the target matcher. Linux Electron UI, musl, ARM64, native
installers and live conversations are not covered.

On 2026-10-26, fresh main, preload, renderer and worker builds passed real settings-page acceptance
under Windows Electron 37.10.3, without a mocked IPC bridge. The four scenarios covered an empty
path, successful 1.4.7 and 1.3.6 operations with repeated no-op notifications, and safe 1.1.2
rejection with the complete digest and no-write message. Configuration readback, exact file
differences, backup restoration and directory contents were checked independently. The empty
account profile was removed after desktop shutdown; Windows login settings were snapshotted,
restored and compared. The acceptance report retains patch-source hashes and confirms those
sources predate the tested main build. Unrelated concurrent worktree changes are outside this
acceptance scope. This does not establish native installer or live-account conversation behavior.

The owning real-evidence rule already exists; this incident is covered by the new semantic
regression checks rather than a duplicate lesson candidate.

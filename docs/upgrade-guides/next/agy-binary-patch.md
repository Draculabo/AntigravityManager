# Upgrade guide: Restore an Agy CLI patched by an older Manager

Target version: next

## Affected users

Users of the x86 eligibility patch in Manager v0.26.0 or another release with the same global
byte signature may have modified unrelated stream-error handling. Official Windows x64 CLI
1.1.2 is a confirmed false positive. Users who never patched their CLI, or whose operation
failed during pattern matching, can upgrade normally. A pattern-not-found preflight does not
modify the executable or create a backup.

## Required action

1. Close the affected CLI before replacing its executable. Keep its current file and backups
   until their versions and origin are established.
2. If an older Manager reported a successful x86 patch, restore the original executable from
   a verified backup of that exact CLI build, or reinstall the official CLI. Do not restore an
   arbitrary `.bak` from a different release; older implementations could retain stale backups.
3. Configure the actual `agy` or `agy.exe` path and apply the new patch. Windows x64 1.4.7,
   the recorded Windows 1.3.6 build and Linux x64 glibc 1.4.7 have file-service acceptance evidence. An older or unfamiliar layout
   may be rejected safely. Do not force a match or repeatedly retry the same rejected file.

## Data and recovery

Manager configuration, account credentials and databases are unaffected. The operation changes
only the selected executable and its owned backup. Keep the backup identified by the successful
patch result. To undo a patch, stop the CLI and restore that exact original; verify its hash and
`--version` before reuse. Independent-copy acceptance exercised this restoration for Windows
1.4.7 and 1.3.6, and for Linux x64 glibc 1.4.7 in WSL Ubuntu. The Linux check also verifies
preservation of executable permissions. This does not establish that any pre-existing user backup
is valid. Native macOS signing recovery remains unverified.

## Downgrade

Manager data formats are unchanged, but downgrading Manager does not restore a modified CLI.
Restore the correct executable separately. Do not reapply the old x86 patch after downgrading:
its signature can identify unrelated code. The new matcher intentionally rejects x86 Mach-O,
non-PIE ELF and older inline checks until their actual targets have independent evidence.

## Verification

The local operation reports `patched`, and a repeated operation reports `already-patched`
without another executable change. Start the CLI with `--version`; a successful startup does
not prove live conversations or server-side account eligibility. Missing or ambiguous patterns
retain their error code and report the input SHA-256 and preflight no-write outcome.

See the [compatibility checks](../../modules/antigravity-runtime/testing.md#agy-binary-patch-compatibility)
for commands and platform limits, and the [target decision](../../../.agents/notes/implemented/bug-fix/2026-10-25-agy-patch-build-diagnostics.md)
for the verified artifacts and rejected signature.

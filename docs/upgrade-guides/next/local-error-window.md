# Upgrade guide: restart matching app and core for local error diagnostics

Target version: next

## Affected users

Users with a separately running standalone core must update the desktop and core
together. Current owner compatibility is 9 and includes resolved error-window budgets
and private diagnostic operations. The same upgrade also requires the
[physical-attempt audit migration](physical-attempt-usage.md). Embedded users can upgrade normally. The new
dedicated error files do not migrate accounts, audit, Thought or ordinary log data.

## Required action

1. Finish current requests and stop the desktop and any standalone core before updating.
2. Install matching app/core binaries with the bundled `error-window.worker.js` resource.
3. Start the selected owner and inspect Settings → General → Local error diagnostics.
   Each running source must show its own status and allocation. A stopped source's
   usage remains unknown. Capacity application and disk reclamation can complete separately.

## Data and recovery

New error captures use role-specific format-one databases under the profile's
`error-diagnostics` directory. Existing profile stores are unaffected. Older error
files are not imported as if they contained validated structured records. Failed
opening, unknown versions or mismatched ownership refuse persistence rather than
resetting a database; bounded in-memory fallback and explicit failure status remain.

Before manual backup or restoration, stop every process using the profile and follow
the existing private-profile backup policy. Preserve matching database sidecars when
present; do not delete WAL/SHM to force recovery. A restored error file must have the
same role and supported version. Source clear is explicit record deletion, not a
backup mechanism. No real user profile restoration was performed during this change.

## Downgrade

Older app/core binaries cannot attach to a compatibility-9 owner; stop all
owners and use matching older binaries together. Older versions do not read the new
dedicated error files. Leave those files intact if returning to the newer version;
there is no schema downgrade or conversion. The new optional configuration field
may be ignored by older codecs, and saving with an older binary may omit it. Restore
the desired capacity after upgrading again. Existing account/audit/Thought downgrade
obligations remain independent.

## Verification

Focused tests validate configuration boundaries, resource refusal, handshake matching,
complete sanitized record persistence/reopen, clear generations and bounded content
transfer. The [current reference](../../modules/error-diagnostics/overview.md) identifies
the authoritative behavior and limitations. Controlled SQLite and isolated core checks
do not establish installed UI, real-profile recovery or every platform's filesystem
behavior. Report unavailable or pending sources explicitly and avoid treating a saved
configuration as confirmed physical reclamation.

# Upgrade guide: Re-select the account for an isolated IDE profile

Target version: next

## Affected users

Windows IDE users testing builds that redirected IDE 2.6 credentials to the standalone system
credential, and users of concurrent account-bound workspace profiles. Other platforms retain their
IDE SQLite destination. Existing workspace rows and account snapshot formats remain readable.

## Required action

1. Save work and stop the affected IDE profile before replacing the Manager build.
2. Select the intended account again for the primary IDE, or launch the account's workspace profile.
   The writer targets that profile's database. No automatic migration reads a possibly unrelated
   standalone system credential into an IDE profile.
3. Confirm the account accepted by the official client. Complete official notices manually if shown.
   Other workspace profiles can remain running during normal profile-scoped operations.

## Data and recovery

An existing database receives its normal WAL-aware `.account-switch.backup` before account writes.
Restore only with the client stopped and verify the intended profile and account afterwards.
Do not overwrite a live database or combine it with an unrelated WAL. The existing standalone
Windows credential is preserved. No account rows or snapshots are converted by this change.

Workspace deletion now stops after an observation, close or cleanup failure. Partial directory
cleanup retains the profile record and reports failure; removed files are not reconstructed.
A database-record deletion failure after successful cleanup also reports a partial effect.
Keep a separate backup of any workspace history that must survive deletion.

## Downgrade

Database and snapshot formats are unchanged. A build with the former Windows IDE credential
redirection may update the standalone system credential again; stop clients and re-select accounts
using the destination appropriate to that build. Reverting code does not restore deleted workspace
files or prior account state. A live downgrade and manual backup restoration have not been tested.

## Verification

Focused tests verify profile routing, busy-before-write ownership, scoped process selection and
failed-deletion recovery. Native Windows Electron checks verify distinct SQLite destinations and
unchanged namespaced credentials. Official IDE 2.6 investigation verifies separate A/B sign-in,
provider-populated matching account records, and A restart while B stays running. Short-lived access
token persistence and concurrent AI generation are separate observations; macOS and physical Linux
live acceptance remain unverified.

See [runtime ownership](../../modules/workspace/runtime.md) and the
[decision and evidence](../../../.agents/notes/implemented/feature/2026-10-28-workspace-runtime-ownership.md).

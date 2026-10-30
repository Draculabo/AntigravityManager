# Upgrade guide: Upgrade externally managed core builds with the desktop

Target version: next

## Affected users

Users who start the core independently through the CLI or a service manager must upgrade that
core with the desktop. Owner compatibility `4` carries closed process-ownership evidence and
client credential-write certainty. Earlier compatibility versions, including `2` and `3`, cannot
attach to a version `4` owner or desktop.

Desktop-embedded users and users whose standalone core is launched by the desktop upgrade normally.
For supported in-app updates, the desktop stops the core it launched before installing the update;
after restart it launches the core bundled with the updated application. A core that was already
running when the desktop connected remains externally managed and is not stopped by desktop exit.

## Required action

For an externally managed core:

1. Stop account operations and exit the desktop.
2. Stop the standalone core using its existing service stop procedure.
3. Upgrade both components to the same build and restart the core and desktop.
4. Confirm the selected owner connects before starting account operations. An incompatible owner
   fails verification; the desktop does not silently switch to a local account owner.

## Data and recovery

Account data, credentials and saved configuration are unaffected; no migration or data conversion
runs. If attachment fails, stop the mismatched processes and restart both from the same build.
Do not remove the profile or credentials to resolve an owner-version mismatch.

## Downgrade

Downgrade both desktop and standalone core together after stopping them. Existing data formats
are unchanged by this fix. Mixed old/new processes remain unsupported.

## Verification

The focused `desktop-owner-bootstrap.test.ts` and `core-management-ipc.test.ts` checks validate
version refusal, the matching handshake, stopping a desktop-launched core and leaving an external
core running. The update shutdown and bundled runtime selection paths were inspected; a packaged
update and restart were not exercised for this fix. These checks do not establish a service-manager
installation or restart on every operating system. The owning
[decision record](../../../.agents/notes/implemented/bug-fix/2026-10-17-process-identity-and-support-reports.md)
and [architecture reference](../../architecture.md#correlated-account-operation-diagnostics)
describe the contract and safe failure behavior.

The [Classic switching reference](../../modules/antigravity-runtime/classic-switch.md) describes
the additional diagnostic fields and partial-completion messages. The focused process-diagnostic
and coordinator tests verify serialization and write certainty; they do not establish real-account
switching or a service-manager upgrade.

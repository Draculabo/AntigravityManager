# Workspace Runtime Ownership

The workspace module binds an account and project to an IDE data directory. The runtime module
owns executable selection, credential preparation, process observation, launch and exit confirmation.
Workspace profiles reuse these boundaries rather than introducing another credential authority.

## Credentials

IDE OAuth belongs to `User/globalStorage/state.vscdb` inside the selected data directory, including
Windows IDE 2.6. A prepared writer receives the resolved executable and directory from its launch
context. It updates only that database, preserves unrelated rows and takes the existing recovery
backup before replacing an existing account. IDE writes never update the standalone client's
`gemini:antigravity` Windows credential.

An isolated HOME holds workspace customizations. Desktop launch does not seed
`.gemini/jetski-standalone-oauth-token`; the inspected extension uses that file in its cloud-development
authentication path. It does not manufacture `app_storage.json` consent fields. Official first-run
notices remain owned by the client. Shared extensions, editor settings and explicitly linked shell
configuration are customization sharing, not an operating-system security boundary.

## Operation and process scope

One profile operation lock covers fresh profile lookup, strict process observation, credential
preparation and writes, provisioning and confirmed launch. An already running profile returns its
observed PID without rewriting credentials. Concurrent starts for the same profile share the current
start result. A primary IDE operation excludes concurrent profile operations before any mutation.
Independent profiles can operate concurrently because their credential destinations differ.

Ordinary IDE operations retain configured or observed primary-profile selection. They exclude only
unambiguously identified managed workspace directories, preserving explicitly configured primary
directories and conflicts from unknown or malformed process metadata. Explicit workspace operations
select their own data directory, overriding a primary configured directory argument. Subsequent hot
service, startup and forced-close checks preserve that scope, creation time and executable identity.
Closing one workspace never authorizes closing a peer profile.

Classic keeps its existing hot attempt, single full-restart recovery and complete diagnostic timeline.
Workspace launch is a cold-start operation; an uncertain launch does not dispatch a second instance.
An observation failure is not evidence that a profile has stopped.

## Deletion and partial effects

Deletion holds the profile operation lock until exit confirmation, contained-directory cleanup and
metadata deletion finish. A running profile requires an explicit stop request; a failed or cancelled
close stops deletion. Cleanup checks both the lexical and real parent path against the managed
profile root. Access failure is not interpreted as a missing directory.

Directory cleanup precedes metadata deletion. A cleanup failure retains the profile record for
diagnosis or retry and reports its original cause. Some files may already have been removed; they
are not restored. If metadata deletion fails after successful cleanup, the record remains but its
directory is already absent. A subsequent launch can recreate the directory from the bound account;
it cannot restore deleted workspace history. A launch rechecks profile existence under its lock so
an earlier lookup cannot recreate a profile that deletion has removed.

## Validation and recovery

The lifecycle-owner and deletion tests exercise busy-before-write behavior, coalesced starts,
observation failures, stopped-state leases and incomplete cleanup. Primary-profile, preflight,
hot-service and captured-tree tests cover peer survival and unknown-owner rejection. The native
client-account integration script verifies distinct SQLite destinations, peer preservation and
unchanged namespaced Windows credentials.

Live acceptance additionally requires separate fresh official sign-in transitions, provider-populated
matching identities, A/B concurrency, peer survival while A restarts and verified shared-credential
restoration. Account text and tokens stay out of reports. These checks do not establish concurrent
AI generation, macOS keychain behavior or every future official-client version.

Rollback restores code behavior; it does not restore deleted directories or overwritten account
state. Stop the affected profile before restoring its database and WAL-consistent backup. Existing
workspace rows and client credential formats are not migrated by these ownership changes.
See the [upgrade instructions](../../upgrade-guides/next/workspace-credential-ownership.md) when
replacing a build that used another Windows IDE credential destination.

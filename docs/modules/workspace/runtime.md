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

Changing a running profile's account or project holds the same operation lease through confirmed
shutdown, metadata persistence and one full restart. Name-only edits do not restart the client.
Failed shutdown preserves the old binding. A persistence or restart failure remains an error;
the UI refreshes saved metadata even on failure rather than claiming that the old binding is active.
An uncertain restart returns `RESTART_UNCONFIRMED` with a saved-settings message and does not
dispatch another instance automatically. Account or project changes allow the existing shutdown
timeout to escalate to a confirmed forced exit within the selected profile's process scope.

List status uses one process snapshot for all profiles. Unavailable observation is shown as unknown,
not as confirmed exit. The running control does not promise an unsupported window-focus action.

Ordinary IDE operations retain configured or observed primary-profile selection. They exclude only
unambiguously identified managed workspace directories, preserving explicitly configured primary
directories and conflicts from unknown or malformed process metadata. Explicit workspace operations
select their own data directory, overriding a primary configured directory argument. Subsequent hot
service, startup and forced-close checks preserve that scope, creation time and executable identity.
Closing one workspace never authorizes closing a peer profile.

Native Linux and Windows discovery excludes same-executable descendants of an observed client
when they have no explicit data directory. Ancestry and creation times come from the same snapshot;
separate roots, explicit directory instances and different installations remain candidates.
This prevents a transient Linux fork before `exec` from becoming an implicit primary destination.

Managed-directory classification uses the Manager's profile namespace independently of whether WSL
launches a Linux client or a Windows executable. Mounted Windows profile paths retain Windows
case-insensitive classification when canonical process paths use different letter casing.
Editor settings and extensions use the captured
client runtime; Linux clients do not inherit Windows extension binaries merely because they run
under WSL. The settings source is the IDE user directory.

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

Customization sharing is optional for startup. Each sharing step reports its outcome; batch
synchronization holds the stopped-profile lease and defers running or busy instances. Failed steps
are not counted as reconciled. Existing customized physical directories are preserved. Recognized
scaffolding is renamed to a unique sibling sharing backup before linking; link failure restores the
original directory when the destination remains absent. If restoration fails, the backup remains
available and the operation reports failure. Backups are not automatically deleted. Never infer an
empty configuration from filenames alone. Sharing never fabricates consent or copies OAuth files.

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

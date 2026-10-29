# Agent Note: Workspace credential and process ownership

Status: implemented

## Problem

Independent IDE profiles must not share a credential destination or select a peer's process tree.
A version-based Windows IDE credential redirection would make separate data directories write
the same standalone-client system credential. Workspace provisioning also occurred before process
operation ownership, allowing rejected operations to mutate credentials. Deletion could continue
after failed process observation or shutdown.

## Decision

Keep desktop IDE OAuth in its captured profile's SQLite UnifiedStateSync state, including Windows
IDE 2.6. Use the existing prepared writer and transactional recovery backup. Do not create a
standalone HOME token mirror or accepted-terms records for desktop workspace startup. Keep the
[prepared-storage decision](../architecture/2026-10-02-prepared-client-account-storage.md)'s other
snapshot and Classic obligations.

Acquire profile operation ownership before fresh process observation or provisioning. Re-read
profile existence and binding under that lock. Preserve primary-versus-profile process scope
through preparation, service replacement, start confirmation and captured-tree cleanup. Exclude
only positively identified managed peers from ordinary IDE discovery; keep unknown-owner and
installation conflicts. Hold the same lease through stopped-state deletion and report partial
filesystem effects without discarding the profile record on cleanup failure.

Retain the existing Forge native rebuild and isolated standalone dependency tree. Remove the
custom shared-dependency patch/rebuild hook whose fixed Electron and Node ABIs do not match this
repository's runtime versions. Workspace tests use the existing portable Vitest selection.

## Alternatives considered

- Serialize writes to one OS credential: prevents overlapping writes but cannot provide persistent
  simultaneous account isolation.
- Set HOME or disable a Linux secret-service address as proof of Windows credential isolation:
  neither changes the Windows vault target.
- Relax every process-directory conflict: can close an unknown installation or write live state.
- Infer authoritative credentials from one successful write or a mismatch between stores:
  neither establishes official-client consumption.
- Treat failed observation or stop as permission to delete: risks removing a running client's data.
- Rebuild native dependencies in place for fixed unrelated runtime versions: changes shared
  development dependencies and bypasses the established standalone boundary.

## Consequences

Customization reconciliation preserves existing config content and renames recognized scaffolding
to a unique sibling backup before linking. Recovery failures retain that backup and report a partial
result. Batch synchronization uses the stopped-profile lease; running instances remain untouched
and pending. The Manager profile namespace is independent of the official client's runtime platform,
while settings and extension sources follow the captured runtime. No existing profile rows move.

Runtime-affecting binding edits use a full stop/save/start operation under one profile lease.
Name-only edits do not restart. Shutdown failure prevents persistence; later failures expose saved
metadata and an error rather than restoring against an uncertain process. Lists share one process
snapshot and represent unknown observation explicitly. These are lifecycle contracts rather than
additional credential authorities or an alternative hot-switch implementation.

Workspace account credentials and process ownership are profile-scoped; customization sharing
remains intentional and does not provide OS-user security isolation. Classic keeps its existing
single hot attempt, full restart fallback and closed diagnostic timeline. Workspace launch does
not retry an uncertain dispatch. No existing client credential format or workspace row is migrated.

Directory cleanup can partially succeed before failing. Metadata is retained on cleanup failure;
if metadata deletion fails after cleanup, its record remains with an absent directory. Errors
propagate, and code rollback cannot recover removed files. Current behavior and recovery are in
the [workspace runtime reference](../../../../docs/modules/workspace/runtime.md).

## Verification

The inspected official Windows IDE executable reports version 2.6.0 and SHA-256
`df765a8ae84a673ae9e8c8e60eca8e7e839351029c58803a107b8f010ce7b736`.
Its active `resources/app/out/main.js` connects desktop OAuth subscription and renewal events to
`uss-oauth`, whose lifecycle reads and persists `antigravityUnifiedStateSync.oauthToken` through
application storage. Application storage resolves to the selected data directory's default
profile database. The extension's HOME token-file fallback belongs to its CDE authentication path;
it is not evidence of a desktop system-keyring transition.

Isolated Windows A/B investigation seeded separate databases with invalid expired access tokens
and authorized refresh tokens, without HOME standalone-token files. Both official clients recorded
fresh signed-in transitions. After confirmed exit flushed provider state, each database contained
the matching provider-populated account status rather than its seeded minimal record. A restarted
while B remained alive and signed in. The exact shared Windows credential was unchanged and its
in-memory recovery snapshot was verified; owned processes exited. Reports omit account identities
and token values.

The inspected client did not persist renewed short-lived access tokens into the original OAuth
row. Provider-populated identity after flush and fresh login are recorded separately from that
negative observation. Concurrent AI generation, new first-run consent, macOS, physical Linux and
future official releases remain outside this Windows investigation.

Focused regressions cover primary discovery, explicit workspace directories, unknown owners,
peer-preserving hot-service and forced-close checks, operation locks, deletion and Classic
recovery diagnostics. The native client-account integration script verifies real SQLite isolation,
backups, transaction failure and unchanged namespaced Windows credentials under Electron. This
does not substitute for packaging or live-provider generation acceptance.

The workspace maintenance regressions additionally exercise nonempty configuration preservation,
link failure restoration, retained backups after failed restoration, stopped-state batch sharing,
running binding replacement, saved metadata after uncertain restart, shared status observation,
and mounted Windows path casing under a native WSL client. Component checks exercise localized
unknown status and a failed deletion that keeps its recovery message visible. Synthetic browser
previews cover English and Chinese desktop layouts, a narrow Chinese layout and the restart warning;
they do not exercise packaged IPC.

Visible WSL checks with official Linux IDE 2.5.5 confirmed concurrent fresh A/B sign-in and primary
discovery excluding managed peers. One run also confirmed running account replacement with the peer
unchanged. Full repeated acceptance remains incomplete: folder-trust prompts blocked renderer
inspection in earlier runs, and the final run reported `exit-unconfirmed` during shutdown. A separate
scoped recovery with a longer shutdown budget confirmed the remaining owned process exited and
removed its test directory. The failed run remains failed; it does not establish reliable repeated
restart acceptance, Windows 2.6 behavior for this maintenance change, or concurrent AI generation.

Follow-up WSL measurements retained the existing six-second native shutdown deadline. Four A/B
rounds shortly after startup and four rounds after ten seconds of initialization passed all sixteen
stops (495–2943 milliseconds), preserving the selected peer and confirming fixture cleanup. Native
snapshot samples completed in 7–22 milliseconds; these samples do not prove the earlier
`exit-unconfirmed` cause. A later full-chain run confirmed initial A/B sign-in and managed-peer
exclusion but failed rebound authentication. Isolated official auth logs recorded `loginError`
and a network socket disconnect before the secure TLS connection was established. Both failed
full-chain runs remain failed, despite successful shutdown and cleanup. No timeout, credential
format, proxy configuration or process ownership rule was changed to obtain these observations.

Static inspection of official Linux IDE 2.5.5 located main-process token renewal through
`google-auth-library` 10.3.0 and `gaxios` 7.1.2. That transport resolves request or proxy environment
settings independently of Chromium's command-line proxy. Credential-free endpoint checks succeeded
both directly and through the configured HTTP proxy. A controlled child-environment proxy run still
failed official OAuth with the pre-TLS disconnect signature. A temporary forwarding relay confirmed
that the official process inherited the proxy and made OAuth CONNECT requests through it; initial
A/B login succeeded, while a separate primary-process assertion failed in that run. These results
do not justify automatic proxy-environment derivation in production or identify the network hop
closing the failed TLS connection. No such production routing change was made.

The subsequent relay-assisted visible WSL run passed the complete A/B sequence using the unchanged
production bundle: initial fresh login, correct per-profile credentials, duplicate-launch preservation,
primary exclusion, running A-to-B rebinding, restoration to A, A stop/restart while B remained signed
in, and provider-populated identity after final exit. It recorded 48 OAuth CONNECT requests and
confirmed proxy inheritance. All owned processes, profile directories and the relay were cleaned up;
pre-existing token-file hashes were unchanged. This is one successful run with an isolated diagnostic
proxy environment, not proof that intermittent TLS failures or the earlier one-off primary-selection
assertion are resolved. It does not establish unchanged-environment repeated acceptance or Windows,
macOS, packaged Manager or concurrent AI generation behavior.

The primary-selection investigation subsequently reproduced a Linux forked child being returned as
an independent client: its native snapshot retained the IDE executable but lacked an explicit data
directory or recognized role arguments. The same snapshot linked it to the live B profile, with a
later creation time. Native discovery now applies the existing same-executable ancestry filtering
to Linux as well as Windows. Explicit data-directory candidates, independent roots, younger-parent
conflicts and different installations remain visible. The owning observer regression fails before
the fix; focused observer, primary, startup and scoped shutdown checks pass after it. The change
does not alter credentials, proxy routing or shutdown deadlines. Intermittent TLS is excluded from
the current acceptance blocker at the maintainer's request; its suspected VPN cause remains unproven.

The credential-free official-client reproduction failed in consecutive runs before this correction,
including a captured child-to-B ancestry chain. After correction it completed six A/B start/stop
rounds and 144 primary-discovery checks with no selected managed peer, preserving B while stopping A.
All owned processes exited and profile directories were removed. Focused Windows and WSL runtime
selections passed 105 and 142 tests respectively. This establishes the observed Linux discovery
regression independently of OAuth; it does not repeat live-account authentication on this final bundle.

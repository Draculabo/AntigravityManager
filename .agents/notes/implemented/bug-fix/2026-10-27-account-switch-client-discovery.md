# Agent Note: Account-switch discovery and forced Windows cleanup

Status: implemented

## Problem

Production switch diagnostics include missing executables, windowless clients and unconfirmed
exit. Source comparison identifies missing engine-role exclusions, stale configured paths
shadowing running binaries and Windows installation layouts absent from discovery. Those
mechanisms are supported candidates, not proof of every reported incident. Local Windows and
WSL acceptance already exists and does not establish coverage of all installations.

The user explicitly requested that switching finish by force after an unanswered save prompt.
This changes the switch-specific protection selected by the earlier
[normal-close decision](2026-10-03-windows-normal-client-close.md) and
[hidden-window decision](2026-10-09-windows-hidden-client-close.md).
Their ordinary-stop guarantees remain active. The
[process identity and reporting decision](2026-10-17-process-identity-and-support-reports.md)
continues to own exact names, conflict protection and sanitized causes.

## Decision

Share token-aware helper-role detection between discovery and observation. Engine and IPC
arguments exclude a process before configured or captured path matching. Keep independent
instances visible to installation/profile conflicts.

A missing configured binary may use an observed executable only in the same canonical parent
directory, followed by all existing installation/profile checks. Without that evidence, preserve
the missing-executable error. Never rewrite configuration automatically. Discover additional
Windows user/system roots, IDE name variants and absolute PATH entries. Distinct discovered
installations without configuration or a running instance are a conflict. Generic Classic
filenames in IDE layouts still require explicit configuration.

Account switching alone opts into Windows forced cleanup; ordinary stop keeps normal close.
Capture the selected roots and descendants before requesting close. Validate executable and
creation-time identity, reject self-containing trees, retain captured reparented descendants,
and freshly check installation/profile and replacement main instances before force. WSL obtains
creation timestamps through its existing validated CIM bridge. A failed query or missing identity
does not authorize termination. Native Windows and WSL invoke the absolute local taskkill with
array arguments, then independently confirm captured-tree exit and no target main processes.

Normal-close failure or grace expiration permits one forced-cleanup phase with a separate
fifteen-second budget. Pending and cancelled save prompts can be bypassed; unsaved buffers and
child work can be lost. A failed force or uncertain observation stays a failure and blocks the
restart path's credential writes. Hot-switch fallback may already have changed credentials and
retains partial-completion semantics. No automatic relaunch follows an uncertain startup.

## Alternatives considered

- Copy broad executable substring matching or orphan sweeping: can select another installation.
- Ignore stale configuration and choose any running installation: changes the selected data owner.
- Force ordinary stop too: outside the user-authorized account-switch policy.
- Treat taskkill success as complete exit: leaves process survival and replacement unverified.
- Introduce Classic hot switching now: separate client lifecycle and terms-retention acceptance.
- Change credential payloads, refresh policy or Mac fallback: independent from this first slice.

## Consequences

No credential location, database format or IPC envelope changes. The optional stop policy is an
internal runtime contract. Existing close reasons continue across process boundaries. Existing
SDK schema and owner compatibility versions remain unchanged. No additional dependency is needed.

Users must save work before account switching; see the
[upgrade guidance](../../../../docs/upgrade-guides/next/account-switch-close.md).
Code rollback restores the previous close policy but cannot recover lost unsaved buffers.
Process creation timestamps plus paths are observations, not atomic OS process handles; PID
reuse between the final check and taskkill dispatch remains a platform limitation.

## Verification

- Focused identity, observer, context, discovery, stop and switch suites plus launch, normal-close and path suites pass 186 tests.
- Review finding R1 reproduced native argv reconstruction misclassifying ordinary title values
  as helper flags. Observation and cached discovery now retain native argument boundaries;
  both failing regression cases pass after the fix.
- TypeScript checking passes.
- The native Windows launch fixture passes three cycles, independently confirms all nine
  disposable processes disappear each cycle, records exactly three launches and no reopening.
  It confirms ordinary windowless refusal before using the switch-only forced policy.
- The real WSL Windows fixture passes process identification, argument round-trip, ordinary
  windowless refusal and switch-only forced exit, with one launch and no reopening. Its complete
  CIM query revealed PID 0; the bridge now accepts system rows and excludes PID 0 from control.
  Cold-query evidence also removed duplicate verification calls from the bounded force phase.
- Native WinForms checks pass visible and hidden normal-close flushing, ordinary cancelled-close
  survival and switch-only forced exit of the refusing window without a saved-buffer claim.
- Earlier Windows fixture runs used Node 24.22.1. Final Windows fixtures and official-client
  acceptance use pinned Node 24.22.0; the WSL disposable fixture uses Node 25.2.1.
- Official-client account identity passes the twelve Windows CLI-owner checks recorded below.
  Electron-owner execution and existing real conversation retention pass the follow-up below.
  New provider generation, live updater interaction and packaged installer behavior remain
  unverified; process cleanup cannot establish unsaved-buffer persistence.

## Live acceptance follow-up

Current-source core, CLI and acceptance helpers were built for the existing isolated Windows
account pair with the pinned Node 24.22.0 runtime. The initial Classic run failed in client
selection. A retained rerun confirmed cloud token ownership for A/B but initially needed manual
official terms completion. Local A/B then confirmed stored credentials, live Google identity
and visible official identity. Return-to-A startup remained unconfirmed. IDE cloud A/B and
local A confirmed official authentication plus live Google identity, but later switches failed.
Every completed run reported the owner stopped and the exact original shared credential restored.
These are failed matrices, not complete A-B-A or history acceptance.

The IDE failure recorded transient unreadable executable/argument metadata at the one-second
preflight deadline. Native Windows launch-context preparation now shares five seconds between
updater and client observation, preserving the existing bounded partial-snapshot retry and all
conflict checks. Ordinary status queries stay at one second. The production preflight/observer
regression reproduced failure before the fix; the combined focused suites pass 52 tests. This
change gives transient observations time to resolve; it does not prove every real failure has
the same cause. A later real WSL fixture independently reproduced the six-second startup-confirmation failure.
Windows runtime confirmation now permits fifteen seconds for two cold observations while
retaining one dispatch, stable identity, and rejection of late results; native Linux/macOS stay
at six seconds. Two four-second snapshot regressions failed before this change and pass after it.

An independent renderer build was stopped before timed IDE verification to remove concurrent
build load. That later IDE matrix still failed, so load alone does not explain the result.
Electron owner and conversation-history acceptance have not run against this change. Private
logs and sanitized reports remain under the ignored out/account-switch-phase1-20261027-mEoQIJ
directory. No production release decision is established by these partial live checks.

The next local-close reproduction captured a descendant with an unavailable executable path
and available creation timestamp. It reproduced immediate close failure. Shutdown now retries
only incomplete descendant snapshots within its existing phase deadline. Captured orphan rows
with missing metadata are not absence evidence. Persistent incompleteness still aborts, and
normal close skips a root replaced while waiting for a readable snapshot. The original minimal
local A-B-A command sequence passed after the snapshot fix and restored the shared credential.
That minimal run proves command lifecycle only, not live account identity or conversation history.

## Final live result

The source build identified by artifacts-verified.json completed all twelve Windows CLI-owner
checks: Classic and IDE each passed cloud A-B-A and local-snapshot A-B-A with the clients kept
running between switches. Each check matched saved token ownership, live Google identity and
the official client authentication/visible identity. Both matrices reported ownerStopped and
originalCredentialRestored true. No official terms were accepted automatically; the user
completed the isolated Classic setup manually. Historical failed reports are retained separately.
This does not establish an Electron-owner path or conversation-history preservation.

Review finding R2 reproduced a conflict with the existing installer-protection contract: an
updater launched below the client during normal close could enter forced tree termination.
Cleanup now rejects such an observed descendant with update-in-progress using the existing
snapshot. The negative test failed before the guard. The live matrices above cover the unchanged
normal switch path before this review-only guard; no live updater was deliberately launched.
An installer spawned between the final snapshot and taskkill remains subject to the same
non-atomic OS observation limitation as other tree changes.

## Electron and history follow-up

The current-source Electron owner passed all twelve checks: Classic and IDE cloud A-B-A and
local-snapshot A-B-A through the renderer MessagePort/IPC client. Every check confirmed stored
token ownership, live Google identity and official client authentication. The empty-account
desktop startup/IPC check also passed with no captured page errors. This exercises the renderer
transport rather than clicking the account-card buttons. Each matrix restored the exact shared
Windows credential, and the wrapper restored and compared relevant Windows login startup items.

The first hand-built acceptance main bundle used generic web-build settings, replacing runtime
process.env reads with an empty object. Classic version detection fell back to SQLite and the
credential-store identity check failed. The saved test accounts themselves passed live Google
identity. Rebuilding main/preload/workers with the installed Forge getConfig factories removed
that artifact mismatch; the unchanged identity matrix passed. Original failures and hashes remain
in the private run directory. The isolated build compared 1,253 source files byte-for-byte with
the workspace. No production source change was made during this follow-up.

A new official IDE request was rejected by the provider with FAILED_PRECONDITION and an
unsupported-location message. The original history run failed at wait-provider, before normal
close or history recovery; owner stop and credential restoration both passed. No network or
location workaround was attempted. A separate scenario selected an existing real test reply,
confirmed its exact visible text and persisted steps, then verified the same history entry and
reply after normal restart and cloud A-B-A. That scenario passed all three account identity
checks, cross-account history, owner stop and exact credential restoration. It establishes
existing persisted history retention, not new provider generation or unsaved/streaming recovery.

Node 24.22.0 and Electron 37.10.3 were used on Windows. The source-build reports and hashes are
artifacts-desktop-next.json, electron-acceptance-summary.json, windows-ide-history-report.json
(the failed generation scenario), and windows-ide-existing-history-report.json (passed retention)
under out/account-switch-phase1-20261027-mEoQIJ. Installer/package and live-updater acceptance
remain outside this evidence.

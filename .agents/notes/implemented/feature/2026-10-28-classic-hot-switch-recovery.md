# Agent Note: Classic hot switching with full-restart recovery

Status: implemented

## Problem

Hot-service discovery, termination or replacement failures must not make an otherwise restartable
account operation unusable. Native Windows Classic 2.23.0 acceptance initially returned partial
results for cloud and local B switches: new services and target credentials existed, but the
official consent slot still belonged to A.

The existing twelve-step failure report could not retain a recovered operation's complete
timeline. Local snapshot translation also discarded finalized diagnostics across owner/RPC/IPC
boundaries, losing support references and potentially reporting the same failure again.

## Decision

The [Classic coordinator](../../../../src/modules/antigravity-runtime/switch/classicSwitch.ts)
owns one hot attempt and at most one full restart using the frozen installation/profile. Cloud
and local owners retain account preparation, serialization, credential destination selection and
the final account-state update. The existing IDE route is unchanged.

Native Windows credential-store Classic attempts hot switching when the selected main instance,
installation-owned AI descendants and terms owner are available. Other platforms, WSL interop,
SQLite storage and absent/unrecognized layouts use restart. No version-label whitelist rejects
an otherwise restartable operation.

Hot preparation, consent capture, write/readback, service retirement, credential reassertion,
replacement and official consent-confirmation failures enter restart recovery. The restart owner
independently reobserves the original main instance; it does not require the failed service
observer to recover first. It uses the existing close, full-exit confirmation, target write/readback,
genuine consent restoration and single-launch sequence. Pending save prompts retain the existing
switch-only forced-cleanup policy, which can lose unsaved work.

Original-instance replacement or user closure, installation/profile conflicts, updater activity,
unconfirmed full-tree exit, post-exit credential failure and uncertain dispatched startup remain
terminal. Recovery never relaunches after uncertain startup, writes after unconfirmed exit or
switches back to the old account implicitly. Prelaunch terms rollback retains its failure alongside
the initiating failure; launch dispatch prevents rollback against a possibly running client.

The official writer owns the live consent file. The hot route preserves genuine history and waits
up to five seconds for the official slot to match the selected account. A stale slot selects restart,
where the existing consent owner can restore a previously observed record. New consent still
requires the official dialog. No terms are accepted automatically and no live file is replaced.
The [current reference](../../../../docs/modules/antigravity-runtime/classic-switch.md) owns the
runtime contract and evidence limits.

One diagnostic identity spans entry, preparation, both attempts and final account state. A closed
trace records ordered starts/results, logical function owners that survive bundling, elapsed times,
continuation decisions, partial effects, native/process classifications, bounded cause chains and
allowlisted source coordinates. Its 32-event/48-KiB limit covers the finite operation. Supplemental
cause/frame truncation is explicit; a recovery summary stays within the existing 2-KiB public
diagnostic. Local snapshot errors retain that diagnostic through owner, private RPC and desktop IPC.

Successful recovery returns success and finalizes account metadata once. The operation owner
reports one recovered warning subject to existing consent; terminal reports retain both attempts.
Sanitized exports and Sentry projection validate closed evidence instead of arbitrary exception
prose, tokens, emails, user paths or command lines. Diagnostic logging or SDK dispatch failure
cannot reverse successful switching. Credential formats, database schemas, proxy configuration
and release behavior are unchanged.

This decision retains the
[Windows close policy](../bug-fix/2026-10-27-account-switch-client-discovery.md) and
[proxy environment boundary](../bug-fix/2026-10-27-core-proxy-environment.md).

## Alternatives considered

- Stopping on hot-step errors would reduce availability despite a usable restart route.
- Ignoring hot errors or accepting a new PID would hide partial writes and the reproduced stale
  official consent state.
- Requiring service recovery before permitting restart would defeat recovery from service-observation
  failure itself.
- Unbounded retries or duplicate launches would amplify races and obscure uncertain effects.
- Automatically accepting terms or replacing a live consent slot would cross the consent boundary
  and race the official writer.
- Reporting only the restart error would lose the initiating failure. Reporting recovered
  operations as terminal failures would misrepresent the result to users and support.

## Consequences

Some Classic builds use full restart on cross-account changes even after service replacement.
This preserves availability; same-account hot switching can retain the main process. Process,
credential and consent observations do not prove a real AI response. Normal switching does not
automatically send a billable test message.

Native observations are not atomic. Process ownership and confirmed exit remain control
preconditions. Persistent permission, storage, update or upstream failures can defeat restart;
diagnostics describe observed effects and uncertainty instead of promising universal success.
Other platforms retain restart until native hot evidence supports them. An SDK event ID is not
proof of remote delivery.

## Verification

- Focused tests inject each hot failure and each reachable restart failure through the production
  coordinator, verifying one restart, post-exit reconciliation, one final account update, both
  failures and uncertain-startup behavior without another dispatch.
- Service tests cover installation/ancestry boundaries, PID reuse, actual retirement, replacement,
  independent restart ownership and late query results. Terms tests reproduce an old official slot
  without writing a running client's file.
- Owner tests cover embedded and private-RPC behavior. Local tests preserve the support reference
  through desktop IPC and existing error details. Trace tests cover logger/export/SDK normalization,
  closed projections, bounded supplemental data and diagnostic failure isolation.
- Windows Classic 2.23.0 CLI-owner cloud and local A-B-A passes all six official identity and durable
  consent checks after the consent-confirmation fix. The same-account hot route preserves the main;
  cross-account recovery uses new mains. Original Windows credentials are restored exactly and
  the isolated owner stops.
- Windows Classic 2.27.0 source-build Electron acceptance passes cloud and local A-B-A through
  real IPC. A separate CLI/Core run confirms four fresh AI replies across initial, same-account
  hot and cross-account recovered transitions. Official updated consent is completed manually.
  Both runs restore the original credential; desktop login settings and preferences are restored.
- Real Sentry SDK localhost receivers preserve the complete switch traces in standalone Node and
  embedded Electron, with nine passing fixtures each. Remote delivery, installers and other
  operating systems remain unverified. The [verification reference](../../../../docs/modules/antigravity-runtime/testing.md#classic-hot-switch-recovery)
  owns artifact/version limits and separates synthetic, native and provider results.

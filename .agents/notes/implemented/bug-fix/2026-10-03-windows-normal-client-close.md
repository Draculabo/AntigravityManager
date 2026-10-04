# Agent Note: Windows normal client close

Status: implemented

## Problem

[Issue #331](https://github.com/Draculabo/AntigravityManager/issues/331) identifies that Windows restart switching immediately uses forceful tree termination. Pending client conversation buffers and save prompts cannot reliably complete through that path.

## Decision

The runtime invokes local `taskkill /PID` without `/F`, `/T` or remote-host arguments for verified main process IDs, using the existing bounded process execution interface. Windows and WSL control of Windows applications share this policy. Exit observation and directory/installation checks remain authoritative. No forced termination follows a refused close or timeout. The normal restart flow writes account data only after confirmed exit. A hot-switch fallback retains its existing partial-completion semantics because credential writes may precede fallback.

## Alternatives considered

- Windows PowerShell `CloseMainWindow()` passes WinForms fixtures but an official IDE run remains alive after the request. Local non-forced taskkill passes the refusal fixture and the official IDE history round trip.
- Automatically forcing termination after a grace period preserves the reported data-loss risk.
- Adding native window enumeration duplicates functionality available through the existing Windows utility. Clients must finish shutdown or the operation aborts safely.

## Consequences

Save prompts, windowless clients and clients that remain alive after closing their main window can require manual closure. The Windows taskkill utility must be available. No remote-host parameters or force flag are supplied. No dependency is added, credential storage is unchanged, and native Linux/macOS shutdown behavior is outside this Windows fix.

## Verification

- A regression test fails on the previous `/F` dispatch and passes after the change.
- Focused stop, switch and hot-switch tests cover failure propagation and account-write suppression on unconfirmed close.
- `scripts/test-windows-graceful-close.integration.mjs` executes production stop logic with real disposable WinForms windows: an accepted close flushes its buffer; a cancelled close survives and reports an unconfirmed exit. Its process observer is fixture-scoped, so this is native window-close evidence, not official IDE conversation-history evidence.
- The existing native launch harness treats windowless Windows fixtures as an expected refusal and cleans up only its isolated process tree.
- A real isolated official IDE run verifies an exact provider reply, reopens its unique history entry before shutdown, closes and restarts through production functions, and recovers the same entry and reply. This covers one completed conversation without changing credentials; it does not cover streaming conversations or every historical chat-loss report.
- Subsequent A → B → A acceptance preserves that completed conversation and verifies credentials, Google identity and official client identity at each switch. The original shared credential is restored after the isolated service stops.
- Streaming diagnostics separately verify two captured response excerpts in the official IDE 2.5.5 SQLite before close and after relaunch. The same entry is absent from the official history list after restart, so the full streaming round trip is not accepted. Some 15-second shutdown attempts also fail exit confirmation safely; longer observation does not establish whole-history recovery.
- The 60-second diagnostic exposes the native query package's documented 30000ms maximum. The native adapter caps each query to that limit without increasing any production operation deadline. A focused regression reproduces the previous RangeError; native-query, stop and observer tests pass after the correction.

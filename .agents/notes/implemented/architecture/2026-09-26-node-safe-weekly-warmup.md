# Agent Note: Node-Safe Weekly Warmup

Status: implemented

## Problem

Weekly warmup execution and post-warmup quota persistence were embedded in the Electron-coupled cloud monitor. Manual quota refresh and post-import hydration need the same effect when the account owner becomes a standalone Node process.

## Decision

Move warmup execution and quota persistence into a feature-owned runner that accepts the existing `WeeklyWarmupExecutor` contract. The cloud monitor still owns polling, notification and auto-switch policy. Desktop startup configures the existing proxy-gateway executor through the monitor, and the monitor delegates to the runner. Manual refresh and post-import use the runner directly. The runner preserves cached AI credits on a post-warmup quota fetch and logs failures without error payloads.

The runner tracks active work. Monitor stop cancels future work and invalidates in-flight quota fetch results before persistence. The underlying warmup service also checks cancellation after project lookup and executor completion, before saving tokens or history. Tray exit and normal Electron quit now use one idempotent cleanup sequence: cancel, drain, stop OAuth and gateway, then allow normal `app.quit()` to finish. Normal quit preserves the updater's quit event. The existing bounded desktop shutdown timeout remains the final process-exit limit.

## Alternatives considered

- Importing `CloudMonitorService` in Node-facing paths would pull in Electron notifications and desktop switching.
- Reimplementing warmup in post-import would duplicate history, scheduling and quota-write policy.
- Keeping untracked fire-and-forget warmups could allow writes during runtime teardown.

## Consequences

Post-import once again schedules the useful warmup effect when configured, without changing the tray to an arbitrary imported account. The standalone core has a composition point for its executor, but quota refresh is still embedded and core startup does not configure warmup yet.

## Verification

Runner tests cover quota and AI-credit persistence, disabled configuration, fetch failure, cancellation and drain before a write. Warmup tests cover cancellation during project lookup and executor completion before token or history persistence. Shutdown tests cover idempotence, drain ordering and timeout. Monitor and post-import tests cover delegation and scheduling. Type, runtime-boundary and core-build checks validate the import graph.

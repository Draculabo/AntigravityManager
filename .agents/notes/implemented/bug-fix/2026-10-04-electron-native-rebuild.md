# Agent Note: Rebuild Electron native modules for every package

Status: implemented

## Problem

The Linux live acceptance build completed but the desktop failed during SQLite initialization.
The packaged binary used Node ABI 141 while Electron required ABI 136. Standalone and desktop
builds coexist in the worktree, so a previously cached rebuild marker does not establish that the
current native binary still matches Electron.

## Decision

Set Forge's existing `rebuildConfig.force` option to `true`. Keep the existing dependency versions,
native module copy hooks and separate standalone resource preparation. Validate real packaged
startup before treating packaging as successful.

## Alternatives considered

- Manually replace the packaged SQLite binary: this fixes one local artifact without making the
  packaging command repeatable.
- Delete all build caches: this discards unrelated state and does not express the required ABI
  boundary in the owning packaging configuration.

## Consequences

Packaging can take longer and requires the existing native build prerequisites. Electron rebuilding
applies to the desktop dependency tree; the separately prepared standalone resource tree retains
its matching Node binaries. No account format, installer behavior or dependency version changes.

## Verification

The pre-change Linux package reproduced the ABI 141 versus 136 failure during real desktop startup.
Post-change Windows and Linux packaged startup and live monitor validation are recorded in the
current acceptance reports. An unavailable platform remains unverified.

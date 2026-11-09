# Agent Note: Stage NSIS upgrades before activation

Status: implemented

## Problem

In [issue #402](https://github.com/Draculabo/AntigravityManager/issues/402), a Windows user reported
an installation error after setup removed the old version. The official x64 v0.29.0 to v0.30.0
upgrade reproduces the failure with an exclusive lock at the new payload's `resources` path after
the old files are removed. The previous installer reports an app-close error and leaves no runnable
installation after cancellation.

## Decision

The [NSIS install step](../../../../resources/windows/nsis-install.nsh) validates the extracted
payload before replacing the registered installation. It stages on the destination volume, keeps the
old directory through activation, and attempts restoration before reporting activation failure.
Backup cleanup removes directory links without traversing their targets.
The direct setup flow confirms the upgrade before closing the running app. The existing updater
flow receives confirmation from the app. The locked `app-builder-lib` patch delegates these two
steps to the project and leaves uninstaller compilation, signing and registration with electron-builder.

## Alternatives considered

- Changing the error text alone leaves the application unusable after a failed write.
- Running the old uninstaller and copying its files back requires reconstructing its Windows
  registration and shortcuts after a failure.
- A complete custom NSIS script bypasses electron-builder's normal uninstaller build and signing
  path. The small template patch keeps that path available.

## Consequences

Setup requires space for the full extracted candidate beside the existing installation. ZIP
extraction exposes a result that setup checks before committing. NSIS already downloads full
installers, so the build omits differential metadata. If both activation and restoration fail,
setup retains the previous directory for recovery. A hard process stop during directory replacement
can also leave that backup in the adjacent staging workspace.

## Verification

Use the [Windows updater acceptance](../../../../docs/testing/delivery.md#windows-automatic-updates)
failure fixture, cancellation and successful replacement checks. Release metadata must match the
generated installer before publication.

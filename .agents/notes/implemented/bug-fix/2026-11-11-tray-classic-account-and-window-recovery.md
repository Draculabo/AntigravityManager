# Agent Note: Classic tray account and window recovery

Status: implemented

## Problem

The native tray could show the account last refreshed in Manager while its next-account action
switched Classic. A hidden startup also depended on a native tray whose initialization could fail.

## Decision

Use the selected account owner's Classic state for the tray display and actions. Treat account
events as cues to reconcile that state. Use the existing quota family policy to project known
percentages and distinguish zero, unknown and provider-blocked quota.

Native tray initialization returns success only for a usable tray. Dispose of a partially created
tray on failure. A hidden launch without a tray restores the main window through the normal
activation path. Existing close and shutdown ownership still applies.

## Alternatives considered

- Selecting the first account active in any client would keep the tray dependent on account order
  when Classic and IDE or CLI use different accounts.
- Adding a second window for recovery would duplicate a path already owned by main-window activation.

## Consequences

The tray remains available in both embedded and standalone owner modes without creating another
account state store. A failed tray cannot leave a hidden startup without its primary window.

## Verification

- Tray checks cover selected-owner actions, quota rows and initialization failure.
- Window activation checks cover hidden startup with and without a ready tray.
- Native operating-system tray behavior is verified separately from controlled Electron fixtures.

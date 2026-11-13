# Agent Note: Desktop Appearance Ownership

Status: implemented

## Problem

Language selection previously updated the renderer, its startup cache, and the tray independently
of the desktop preference write. Late translation work could replace a newer selection, and
different components could display different languages after a failed write. Electron's default
zoom commands also had no application preference to restore and reflect in Settings.

## Decision

Use the existing serialized desktop preference owner for language and page zoom. Apply only
confirmed values. Normalize regional language codes to the supported set at the desktop boundary.
The renderer queues language application and stores its cache after applying the current saved
value. The tray reads the same preference during startup and updates after a successful write.

Apply native zoom through the validated preload surface. Settings, View menu commands and focused
window shortcuts submit the same desktop preference patch. The window reads the saved factor at
creation. Shortcut handling leaves editable surfaces alone. Default zoom stays implicit on disk
so users can reset to 100% before returning to an earlier strict preference reader.

## Alternatives considered

- Renderer-only persistence cannot keep the tray and new windows in sync with the saved preference.
- Leaving Electron's built-in zoom commands active would allow the View menu and keyboard to
  change the scale independently of Settings and the stored factor.

## Consequences

Settings retains the failed selection as a retry action while the last confirmed value remains
active. A custom zoom requires a reset before downgrade. See [Desktop interface](../../../../docs/modules/app-shell/desktop-interface.md#language-and-interface-zoom)
and [downgrade instructions](../../../../docs/upgrade-guides/next/desktop-interface-zoom.md).

## Verification

The desktop preference integration tests exercise the existing IPC route, a reopened store and
the earlier schema shape. Renderer tests exercise slow and failed language work, cache restoration,
and zoom commands from Settings, the View menu, and keyboard input.

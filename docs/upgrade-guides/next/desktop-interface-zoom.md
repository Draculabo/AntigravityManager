# Upgrade guide: Desktop interface zoom

Target version: next

## Affected users

Desktop users on Windows, macOS, and Linux who set an interface zoom other than 100% and later
return to a version released before this preference. Existing profiles can upgrade normally.

## Required action

1. Open the upgraded Manager. Existing profiles start at 100%.
2. To change the scale, open **Settings → General → Interface zoom** and select a percentage.

## Data and recovery

The percentage is stored in `desktop-preferences.json` in the Electron user data directory. The
atomic preference write preserves the previous saved file when a write fails. Use **Retry** in
Settings to try the selection again. The change affects desktop preferences only.

## Downgrade

1. In the upgraded version, set **Interface zoom** to **100%** and wait for the save to finish.
2. Quit Manager, then install the older version. Resetting to 100% removes the new field from disk
   so the older version can read the preferences. An older version can reject a file that still
   contains the custom zoom field. If the newer app is unavailable, restore a verified backup of
   `desktop-preferences.json` from before the custom zoom was set while Manager is stopped.

## Verification

After restarting Manager, confirm the chosen percentage in Settings and the visible scale of the
window. The [preference round-trip test](../../../src/tests/unit/service-config.test.ts) checks
older profiles, saved zoom across a reopened store, and that reset produces a file accepted by the
previous preference schema. See [Desktop interface](../../modules/app-shell/desktop-interface.md#language-and-interface-zoom)
for the supported controls.

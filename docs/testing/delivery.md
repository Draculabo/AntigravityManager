# Packaged Runtime and Installer Acceptance

This procedure owns packaged, installed and updater evidence across desktop and standalone runtimes. Follow the [script instructions](../../scripts/AGENTS.md), isolate host state and obtain the authorization required by each scenario.

Run commands from the repository root unless a step specifies another directory.

## Standalone delivery acceptance

For live provider task acceptance across standalone CLI and Electron owners on Windows and Linux,
follow [Live agent acceptance](../modules/proxy-gateway/acceptance/live-agent.md). The runner records a bounded audit and
token report for a real file-writing task; a successful HTTP response alone does not pass the task.

### Packaged resources

`pnpm run package` prepares the standalone resource tree as part of Forge packaging. For a local
verification build, set `AGM_PACKAGE_OUTPUT` to an isolated output directory and
`AGM_DISABLE_SENTRY_UPLOAD=1` to suppress build-time source-map upload. Release defaults are unchanged.
Preparation requires the target platform and architecture to match the native build host.

`node --test scripts/build/trace-standalone-runtime.test.mjs` checks exclusion of host assets and retention
of required native entries through the actual dependency tracer. SQLite uses the published Node-API
binary for the bundled Node target.

### Native installed runtime

To exercise worker teardown with the packaged Node binary, launch
`scripts/acceptance/runtime/diagnostics-terminal-native.mjs --smoke --runtime-root <packaged-resources>/standalone`
with that binary. The smoke check runs Thought Store first in a fresh process, with SQLite loaded by
the worker. It waits for worker termination following the shutdown response.

Run `pnpm run test:acceptance runtime installed <packaged-resources>/standalone` against the actual resources.
The check copies them outside the repository and removes Node search-path overrides. It verifies
SQLite WAL/read/write/reopen, real OS credential create/read/update/delete across process restarts,
both workers, core owner bootstrap, representative remote adapters, gateway start/stop and its
unauthenticated rejection, external attachment, shutdown, persisted reopen, owned-process crash
recovery and stale-epoch rejection. The whole-run timeout accommodates four cold starts and three
terminal drains; individual production startup and shutdown deadlines remain unchanged.
The installed CLI exercises top-level and subcommand help, invalid-argument exit status, a
structured missing-backup error from Core, and a successful edit to an isolated JSONC settings
file that preserves comments and unrelated settings.
The gateway WebSocket check rejects an unauthenticated upgrade, receives the authenticated local
prewarm event sequence and completes a normal close. A separate loopback socket pair verifies
the bundled WebSocket implementation's compressed UTF-8 round trip and normal close.
An authenticated audit request verifies query validation with both a valid limit and an invalid
limit that returns a field error.
Credentials use a random test-only service name; a test preload maps core
keytar and OpenCode native keyring calls to that name while using the actual native OS store. No production credentials are
read or changed. The presentation composition executes under Node with fail-fast native sentinels,
so this is not an Electron window, installer, live-provider or other-platform acceptance. Core peak
RSS covers an empty profile and audit activity, not the supported large-body ceiling.

Add `--capacity` to read a repository-seeded existing Thought record just below 64 MiB three times.
The check streams every chunk into a full digest, verifies cursor completion and capability closure,
then repeats terminal reopen and crash recovery. It records core peak RSS. This is persisted-record
read compatibility; it does not prove admission of a new 64 MiB capture into the background write
queue, whose byte budget is a separate backpressure contract. Three reads do not establish soak-test
memory behavior.

### Windows desktop

On Windows, `pnpm run test:acceptance runtime desktop <packaged-desktop-executable>` opens real packaged
Electron windows in an isolated profile. It checks embedded and remote startup, settings navigation,
preference restart, packaged CLI service lifecycle, external-core retention and process crashes.
It snapshots and restores only the application's Windows login settings. The actual desktop uses
the normal application keyring service; run this check only with explicit authorization for the host.
It does not install or upgrade the application. Installer recovery and other operating systems
remain separate acceptance requirements.

The Windows desktop check records main-process working set and peak working set, plus idle core
working set, in `artifacts/runtime24-desktop-memory.json`. These are individual process observations,
not the total Electron renderer/process-group memory.

### Windows MSI

On an explicitly authorized Windows host, run `pnpm run test:acceptance installers msi <current-msi>` under
the normal user token. It refuses an already registered product or upgrade family, installs into
an isolated directory, removes one owned worker, verifies exact Windows Installer repair, and runs
the native and real-window checks against the installed resources. It uninstalls only verified test
product identities, checks their registration is gone, and restores previous application shortcuts
and login settings. The existing Squirrel installation registration must remain unchanged.
Installer operations and the nested desktop check have a 15-minute deadline. On a timeout,
inspect the retained MSI logs and wait for any Windows Installer service transaction to finish
before starting another install or uninstall.

For a cross-version fixture, `pnpm run make:msi-upgrade-fixture <packaged-app> <new-out-subdirectory>`
uses the configured WiX maker with the previous patch version. Supply that MSI as the second argument
to `test:acceptance -- installers msi`. The check requires identical upgrade families, different product codes and
x64 metadata, verifies the old product is removed, and preserves an external profile fixture during
upgrade. Both installers contain the current application payload; this verifies installer mechanics,
not historical application/database migration. Existing MSI releases with random upgrade identities
and Squirrel-to-MSI migration are not covered by this fixture.
WiX cleans the previous installation directory during upgrade; user profiles must remain outside
that directory. The profile fixture checks this actual layout, not retention of unmanaged install files.

### Squirrel upgrade

For an existing Squirrel installation, copy its `Update.exe`, root executable, icon, `packages`
directory and versioned app directory into a dedicated directory directly under the OS temporary
directory, with the copied install root named `antigravity_manager`. Then run
`pnpm run test:acceptance installers squirrel-upgrade <authentic-install> <temporary-copy> <squirrel-feed>`.
The feed must contain the current `RELEASES` and full `.nupkg`. The check verifies selected source
and copy hashes, updates only the copy from authentic 0.19.0 through its copied `Update.exe`, and
runs the installed native and real-window checks against the updated app. It snapshots and restores
the application's Squirrel registration, shortcuts and login settings and removes only the verified
temporary fixture after success. An external profile marker survives the update. This establishes
Squirrel package compatibility on the host; it does not replace the user's installed app or prove
historical account/database migration, an in-place rollback or a Squirrel-to-MSI transition.

### Windows automatic updates

For Windows updater changes, run the package-selection unit test and
`pnpm run test:acceptance installers feed`. Build the NSIS installer from the same Forge packaged app with
`pnpm run make:nsis x64 <packaged-app>`; the script checks its installer against the generated
`latest-nsis-x64.yml`. An installed NSIS A-to-B check must exercise a local feed, automatic `.exe`
download, an explicit restart action, the relaunched version and an external profile marker.
`pnpm run make:nsis-update-fixture <packaged-app> <unused-out-directory>` makes the previous
patch-version installer from the same application payload for that check.
`pnpm run test:acceptance installers nsis-updater <previous-installer> <current-installer> <current-latest-yml>`
installs the fixture on an authorized Windows x64 host, checks the app's automatic update and
restores its shortcuts and login settings. Run it only from a disposable Windows account: the
installer's automatic relaunch uses that account's default app profile, even when the previous
process had a temporary profile argument. The check refuses an existing default NSIS installation
or app profile.
Uninstall completion requires the owned installation directory to disappear after the uninstaller
launcher exits. The runner waits up to 90 seconds and treats incomplete cleanup as failure.
After successful cleanup, the NSIS runner writes a JSON report in a fresh
`out/nsis-acceptance-*` directory. It records separate silent fresh-install samples for the
candidate and the previous version,
the time from selecting restart to the old process exiting and to observing its replacement window, and
the candidate's stage durations. The runner derives stage durations from whole-second diagnostic
timestamps. A zero can mean the step finished within the same recorded second. The new process
sample requires a responsive Windows main window and does not exercise a control in the renderer.

Run `pnpm run test:acceptance installers nsis-feedback <makensis.exe>` on Windows to exercise
the production logging functions without a full application payload. Supply an installed NSIS
compiler with its standard includes and plugins. The check compiles a small executable and
runs it with isolated `USERPROFILE` values under a fresh `out/nsis-feedback-*` directory. It
checks native log naming, UTC timestamps, silent/update/failure records, preservation of the
NSIS error flag, five-file retention, the size bound, and continuation when the log directory
is unavailable. It also checks that an absent app is reported as not ready during restart.
It preserves application and unrelated installer logs. The directory retains
the generated fixture, logs and result; it does not change installation registrations, shortcuts
or the current user's application profile. This check does not establish full installer or UI behavior.

Run `pnpm run test:acceptance installers nsis-inventory <packaged-app> <installer.exe> <report.json>`
to record the installer's size and SHA-256, the unpacked Forge file count and size by group, the
ASAR entry count, and byte-identical on-disk files. Supply the Forge directory and NSIS installer
from the same build. All three paths belong under `out/`. Use an unused report path outside the
inspected app tree. The inventory does not extract the installer or prove that an identical file
can be removed.

For an installation performance comparison, use unmodified candidate installers and record the
build revision, artifact hashes, machine and cache conditions. Compare changes to the installer
with the same Forge payload. Measure fresh install, manual upgrade and in-app update separately.
Start interactive timing after the last confirmation and stop at the finish page. Stop silent
timing when the process exits. For user-visible restart time, stop when the new window is
interactive. Alternate baseline and candidate runs at least five times per side and compare the
median and range of successful runs. Save the samples and any CPU or disk traces under `out/`.
These tools, reports and failure fixtures are for repository acceptance.

The packaged Squirrel in-app updater check (`pnpm run test:acceptance installers squirrel-updater`) also
requires a disposable Windows account with no existing app profile because its installer
relaunch may drop the temporary user-data argument.
Check a missing feed, an interrupted download and a tampered installer separately. Packaging
and feed tests alone do not establish installed updater behavior or cross-architecture acceptance.

For the NSIS staging regression, supply an incomplete installer as a fourth argument to
`test:acceptance installers nsis-updater`. Build it with the same NSIS configuration from a
disposable copy of the candidate payload under `out` that omits `resources/app.asar`. Use
`pnpm exec electron-builder --win nsis --x64 --prepackaged <incomplete-payload> --config electron-builder.config.cjs --publish never`
with `AGM_NSIS_ARCH=x64` and a separate `AGM_NSIS_OUTPUT` under `out`. This intentionally bypasses
`make:nsis`'s input check. The runner requires an unsuccessful exit and byte-identical previous
application files, then exercises the normal updater with the complete installer. For interactive
coverage, open the complete installer directly and cancel at the confirmation. Verify the
previous installation remains usable. The updater check also places a directory junction in the
previous installation and verifies that replacing it preserves the linked external file.

For feedback acceptance, expand the progress details while a full payload is extracting. Observe
that Windows continues to respond and that the stage shown matches the work. Check success and
shortcut warnings on an interactive run and an incomplete-payload failure on a registered
installation. Verify that a silent run creates its own local diagnostic file without showing a
wizard. In the disposable profile, put an ordinary file at the expected log directory and verify
that the same installer still runs. Keep each run's observable result separate from any failure
fixture or timed sample.

### Linux AppImage updates

For Linux updater changes, run the focused `linux-appimage-*.test.ts`, update metadata,
automatic fallback and notification tests, then `pnpm run type-check` and
`pnpm run test:appimage-download`. The latter uses real HTTP downloads for x64 and ARM64 feeds,
rejects SHA-512 mismatches and interrupted transfers, and checks the maker's architecture
arguments and paths containing spaces. It does not execute the Linux installer.

Run the native A-to-B check on a Linux desktop with AppImage/FUSE support and a disposable
account. Build the current AppImage with `pnpm run make --platform linux --arch x64`
(use `arm64` on an ARM64 host). Generate the previous-version fixture from that packaged
app using an explicitly lower version and a new directory under `out`:

```bash
pnpm run make:appimage-update-fixture "out/Antigravity Manager-linux-x64" out/appimage-previous 0.23.0
pnpm run test:appimage-update <previous.AppImage> <current.AppImage> <latest-linux.yml>
```

Supply real artifact paths under `out`; ARM64 uses `latest-linux-arm64.yml`. The previous
fixture contains the current implementation with a lower package version, so this exercises
updater behavior rather than historical database migration. The check copies the previous
archive into its own temporary directory, starts a local feed, isolates HOME/XDG paths,
rejects a missing feed and corrupt download, then retries the valid download. It clicks the
restart action and checks the replacement hash, relaunched version in Settings and retained
profile marker. A successful check saves a JSON result and Settings screenshot under `out`
and removes only the owned fixture; failures retain it and its process log for diagnosis.
The disposable account also isolates OS credential-store effects that HOME/XDG do not cover.
The native check enables the existing diagnostic mode with debug port `0` and reads Chromium's
`DevToolsActivePort` file for each process. This avoids a fixed-port conflict while the updater
starts the new process before the old process fully exits.
Run on each supported architecture before claiming native acceptance. No release publication
is needed, and downloaded archives are not installed on ordinary quit.

### Release-note presentation

For release-note changes, run the focused `src/tests/unit/release-notes-*.test.ts` tests and
`pnpm run type-check`. They cover publication-text serialization, exact-tag fallback and response
validation, IPC target/link validation, Markdown/image behavior, download-time inspection, empty
and retry states, dialog version identity and cancellation of late responses. The existing manual
update and external-URL policy tests cover surrounding behavior. These tests do not prove a live
GitHub publication, native browser launch, or installed updater acceptance.

Run `pnpm run preview:release-notes` for an isolated Electron window using the production update
notice, dialog, renderer IPC client and preload. Its controls select complete Markdown, empty
content, one failure followed by retry, a delayed response, and available/downloading/downloaded
notifications. Download and install actions are simulated; the fixture does not load accounts,
start the gateway or install updates. Toggle its theme and resize the window to inspect scrolling
and footer actions. Close the window to stop its local renderer server.

`pnpm run preview:release-notes --live --tag v0.23.0` uses the production resolver against that
published GitHub tag, including metadata validation and exact-tag fallback. Specify another
published tag when needed. The interface defaults to Chinese; `--language en` selects English.
If a shell wrapper drops pnpm's forwarded arguments, run
`node scripts/preview-release-notes.mjs --live --tag v0.23.0` directly. The terminal reports the
selected mode and tag, then confirms when the visible window is ready. It remains running until
that window closes.

`pnpm run test:performance release-notes.spec.mts` runs the repeatable isolated Electron checks
through production preload and real MessagePort IPC, including native request cancellation,
scrolling, themes, empty content and retry. Set `AGM_RELEASE_NOTES_LIVE_TAG` to a published tag
to include the opt-in live resolver check. Screenshots are written under
`test-results/playwright-performance`. This evidence does not establish installed updater behavior
or GitHub Actions publication of new assets.

## Credential probe privacy

Installed-resource credential acceptance uses unique synthetic service names in the real OS store.
Its test preload remaps both keytar and OpenCode's native keyring service, so production grants and
API keys are neither read nor changed. Windows native credential writes require a usable interactive
login session; a restricted execution token can load the native binary but fail OS-store operations.

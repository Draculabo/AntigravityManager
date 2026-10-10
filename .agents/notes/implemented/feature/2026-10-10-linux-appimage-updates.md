# Agent Note: Linux AppImage updates

Status: implemented

## Problem

Linux releases provide multiple package formats, but the app only links to the release page.
An automatic installer must recognize a replaceable archive, select the correct architecture
and let users validate replacement and relaunch before publication.

## Decision

Use the existing `electron-updater` dependency for packaged, writable type-2 AppImages on
x64 and ARM64. Keep the service in app-shell and reuse update notifications and the desktop
shutdown coordinator. Download in the background; install only after the restart action.
Use full downloads because Forge does not guarantee an embedded differential block map.

Keep the existing GitHub release asset feed and architecture-specific Linux metadata.
Package `resources/linux/app-update.yml` because the library reads its cache configuration
even when the runtime supplies a feed explicitly. Exclude DEB/RPM from updater metadata.
Patch the existing maker to forward the requested architecture through assembly and runtime
repacking, and invoke Bash with separate arguments so paths containing spaces stay intact.
Run the downloaded build tool with `--appimage-extract-and-run` so packaging does not
require FUSE libraries or mount access on CI runners. This affects the build tool only;
installed applications retain their existing AppImage runtime requirements.
Remove the patch when an upgraded maker supplies these fixes; its executable regression test
guards those requirements.

Check the original archive and downloaded ELF/AppImage architecture before replacement.
Retain the library's SHA-512 verification. Local feeds require the explicit unmanaged-test
flag; no new renderer-provided URL, IPC contract or durable data format is introduced.

## Alternatives considered

- A custom archive installer would duplicate download, cache, verification and relaunch behavior.
- Automatic DEB/RPM installation would require package-manager ownership and privilege handling.
- Installation on ordinary quit would apply an update without the explicit restart action.

## Consequences

DEB, RPM, unpacked, read-only and unsupported-architecture installations continue through
manual release downloads. Existing Linux clients need a manual upgrade to the first build
containing this updater before subsequent automatic updates can work. macOS remains outside
this change.

The release source and its checksum metadata are trusted together; checksum validation is
not an independent binary signing guarantee. Archive replacement and process relaunch remain
platform-dependent library behavior. A failed download leaves the installed archive intact
and allows retry or manual download. This change does not establish an in-place rollback.

## Verification

Unit tests cover format detection, permissions, architecture, concurrent operations, progress,
retry, cache loss, explicit installation, fallback and notification actions. The real HTTP
download check covers both architecture feeds, checksum failure and interrupted transfers.
The maker regression test checks architecture forwarding and argument-safe Bash execution.
On Linux it also runs the patched shell script against tool fixtures that reject execution
without extraction mode, covering both architectures and paths containing spaces.
The release build runs this check before making Linux artifacts. A WSL2 x64 check on
2026-10-10 blocks `dlopen` of `libfuse.so.2`: the unmodified invocation reproduces the CI
failure, while extraction-mode repacking succeeds with the real `appimagetool` and
application archive. The resulting type-2 x64 archive extracts with its application payload
and patched AppRun intact. Native ARM64 execution remains a CI validation requirement.

Native acceptance uses diagnostic port `0` and discovers each process through its isolated
`DevToolsActivePort` file. A fixed port can remain occupied when the library starts the new
process before the old process exits. Ordinary runs still leave diagnostic mode disabled.

The [native acceptance procedure](../../../../docs/testing.md) builds a lower-version fixture
from the current payload and tests a local feed without publication. It checks replacement,
relaunch and profile retention; it does not prove historical migrations. Linux packaging and
native A-to-B acceptance pass on WSL2 Ubuntu x64 with WSLg and FUSE on 2026-10-10,
including 0.23.0 fixture to 0.24.0 replacement, the rendered Settings version and profile
marker retention. ARM64 native packaging and relaunch remain unverified on this x64 host.

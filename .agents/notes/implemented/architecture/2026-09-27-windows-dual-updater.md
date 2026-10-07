# Agent Note: Windows installer-specific automatic updates

Status: implemented

## Problem

Electron's native Squirrel updater cannot install an NSIS executable. `electron-updater` supports
NSIS but does not support Squirrel.Windows packages. Sending every installed Windows build to one
engine would strand an existing installer population or invoke the wrong installer format.

## Decision

Detect the installed package from its own on-disk markers before enabling automatic updates.
Squirrel continues to use Electron's native updater and the existing architecture-specific
`RELEASES` feed. NSIS uses `electron-updater`, a separate `latest.yml` feed and a verified release
`.exe`; it downloads in the background and installs after the user chooses to restart. The desktop
shutdown coordinator drains owner work before either updater takes over. MSI and unpacked builds
retain the manual release route. Forge packages the application once; electron-builder wraps that
package as an NSIS installer without changing the application payload.

The publisher installs project dependencies from the root lockfile in its own runner job before
running update-feed checks or writing release assets. Installation includes development dependencies
for the acceptance tools and disables lifecycle scripts because the publisher consumes prebuilt
installers. The dispatcher declares its existing `cross-spawn` dependency explicitly instead of
depending on another development tool to install it transitively.

## Alternatives considered

- Replacing Squirrel with `electron-updater` was rejected because that library cannot update
  Squirrel.Windows installations.
- Updating all Windows formats with Electron's native updater was rejected because it only handles
  Squirrel.Windows here.
- Repackaging the application independently for NSIS was rejected because separate payload builds
  could drift in runtime resources and native modules.

## Consequences

The release must carry both Squirrel and NSIS assets for each Windows architecture. The NSIS feed
has its own path so its `latest.yml` never collides with Squirrel `RELEASES`. A build without a
recognized installed marker cannot start an automatic installer. Cross-installer migration remains
manual until a separate data and registration migration is accepted.

## Verification

The package-selection and feed-generation tests cover format routing, release URLs and NSIS
SHA-512/size matching. A packaged and installed A-to-B run is required to establish actual
download, restart and profile retention; other operating systems and architectures need their
own installed acceptance evidence.

The publish-job regression checks that locked JavaScript installation precedes feed validation,
feed preparation and release writes. On 2026-10-07, a clean Ubuntu fixture reproduces the missing
`commander` failure. The workflow installation command then installs 2,156 packages and all three
feed checks pass under Node 25.2.1, including with `NODE_ENV=production`. Dependencies resolve
inside the fixture, Electron's downloaded binary and rebuilt SQLite binary remain absent, and
the temporary checkout is removed. GitHub's Node 22 publisher still requires a new workflow run
after the fix lands; rerunning an old run retains that run's original workflow definition.

# Build and Package Guide

This guide owns native dependency preparation, application artifacts and runtime integrity. Start with the [development quick start](../development.md#quick-start); run delivery checks only for affected artifacts.

Run commands from the repository root unless a step specifies another directory.

## Native dependency preparation

Native process queries use `@draculabo/sysinfo-process-enhanced`. npm installs the matching prebuilt platform package; keep optional dependencies enabled. No Rust build is needed in this repository. For a different packaging architecture, install dependencies on the target runner as the release workflow does.

`npm ci` applies the [Forge 7.11.1 development patch](../../patches/@electron-forge+core+7.11.1.dev.patch) through `postinstall`. Forge's package-bin cleanup uses a relative glob with the package directory as `cwd`, so Windows path separators cannot make it scan unrelated workspace profiles. If dependencies were intentionally installed with `--ignore-scripts`, run `npm run postinstall` before packaging. The isolated production runtime does not run Forge or installation hooks. Remove the patch when the installed Forge version includes this scoped scan and Windows packaging passes with inaccessible directories elsewhere in the workspace.

## Build and package

Run these only when the changed artifact or platform requires them. A successful source build
does not establish installer, native keyring or live-provider behavior.

- `npm run package` creates an unpacked application bundle.
- `npm run make` creates platform distributables and is slower and more environment-sensitive than packaging.
- `npm run audit:size:win32:x64` checks the default Forge output: Squirrel EXE/NuGet and WiX MSI installers have a 200 MiB budget including the standalone runtime; `app.asar` and the uncompressed standalone tree each have an independent 120 MiB budget. The audit selects packaged resources directly and does not scan acceptance profiles elsewhere in `out`. Vite dependency caches under `node_modules/.vite` are excluded from packaging; the production bundles under the root `.vite` remain required.
- Packaging prepares standalone runtime dependencies in an isolated directory. Its `npm ci` preserves the package URLs in `package-lock.json` with `--replace-registry-host=never`, so a local npm mirror setting cannot redirect locked official-registry downloads to an unavailable mirror archive. Dependency versions, integrity checks and global npm configuration remain unchanged.
- Runtime installation and dependency tracing use separate staging directories. Native-module and command checks run against the traced output before publication. On Windows, publication copies the validated tree after backing up any existing generated runtime, avoiding populated-directory rename failures. A failed copy restores the backup; failed recovery retains its staging directory and reports the recovery path. Forge consumes the output only after publication completes. Other platforms publish by directory rename.

Linux AppImage packaging runs the maker's downloaded `appimagetool` with
`--appimage-extract-and-run`, so the build step does not require FUSE libraries or mount
access. Running the installed AppImage still requires a supported AppImage runtime
environment. See [installer verification](../testing.md) for build and native update checks.

## Runtime preparation integrity

Standalone runtime preparation downloads Node only from the official distribution and verifies
the selected asset against its official SHA-256 list. Native rebuilds run in an isolated tree;
they never replace the Electron ABI dependencies. Generated runtime replacement checks its owned
manifest and resolved directory before moving or deleting anything. Failed restoration preserves
the previous tree for explicit recovery.

Dependency tracing scopes filesystem reads to the staging root, rejects cross-drive host paths
and external link targets, and requires the target native binaries before materialization.
Optional import warnings are reviewed explicitly; unknown warnings fail preparation.

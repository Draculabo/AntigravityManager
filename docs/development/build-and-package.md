# Build and Package Guide

This guide owns native dependency preparation, application artifacts and runtime integrity. Start with the [development quick start](../development.md#quick-start); run delivery checks only for affected artifacts.

Run commands from the repository root unless a step specifies another directory.

## Native dependency preparation

Native process queries use `@draculabo/sysinfo-process-enhanced`. pnpm installs the matching prebuilt platform package; keep optional dependencies enabled. No Rust build is needed in this repository. For a different packaging architecture, install dependencies on the target runner as the release workflow does.

`pnpm install --frozen-lockfile` applies the [Forge 7.11.1 patch](../../patches/@electron-forge__core@7.11.1.patch) through `patchedDependencies`. Forge's package-bin cleanup uses a relative glob with the package directory as `cwd`, so Windows path separators cannot make it scan unrelated workspace profiles. The patch is also applied when lifecycle scripts are disabled. Remove it when the installed Forge version includes this scoped scan and Windows packaging passes with inaccessible directories elsewhere in the workspace.

## Build and package

Run these only when the changed artifact or platform requires them. A successful source build
does not establish installer, native keyring or live-provider behavior.

- `pnpm run package` creates an unpacked application bundle.
- `pnpm run make` creates platform distributables and is slower and more environment-sensitive than packaging.
- `pnpm run audit:size:win32:x64` checks the default Forge output: Squirrel EXE/NuGet and WiX MSI installers have a 200 MiB budget including the standalone runtime; `app.asar` and the uncompressed standalone tree each have an independent 120 MiB budget. The audit selects packaged resources directly and does not scan acceptance profiles elsewhere in `out`. Vite dependency caches under `node_modules/.vite` are excluded from packaging; the production bundles under the root `.vite` remain required.
- Packaging prepares standalone runtime dependencies in an isolated directory. Its `pnpm install --prod --frozen-lockfile --ignore-scripts` uses the same lockfile, pnpm settings and native-build allowlist as development. Native dependencies are rebuilt only in that isolated tree with its bundled Node version; desktop dependencies remain untouched.
- Runtime installation and dependency tracing use separate staging directories. Native-module and command checks run against the traced output before publication. On Windows, publication copies the validated tree after backing up any existing generated runtime, avoiding populated-directory rename failures. A failed copy restores the backup; failed recovery retains its staging directory and reports the recovery path. Forge consumes the output only after publication completes. Other platforms publish by directory rename.

pnpm applies the [AppImage maker patch](../../patches/@pengx17__electron-forge-maker-appimage@1.2.1.patch)
through `patchedDependencies`, including installations with lifecycle scripts disabled. The patch
preserves the requested x64 or arm64 architecture and paths containing spaces.
Linux AppImage packaging runs the maker's downloaded `appimagetool` with
`--appimage-extract-and-run`, so the build step does not require FUSE libraries or mount
access. Running the installed AppImage still requires a supported AppImage runtime
environment. Remove the patch when the maker includes these behaviors and
`pnpm run test:appimage-download` passes on Linux for both architectures.
See [installer verification](../testing.md) for build and native update checks.

## Release workflow verification

[Publish Release](../../.github/workflows/publish.yaml) builds Windows, macOS and Linux for x64
and arm64. Linux release jobs use Ubuntu 24.04; macOS uses `macos-15` for arm64 and
`macos-15-intel` for x64. Action references are pinned to complete commits with their release
versions in comments. Action runtimes use Node 24 independently of the project Node version in
`.nvmrc` and pnpm version in `packageManager`.

Dispatch the workflow on the revision being verified with `dry_run=true`. After all builds
succeed, the read-only `verify-artifacts` job downloads and merges this run's `make-*` artifacts
with digest mismatches treated as errors. It validates the six-target inventory, nonempty
platform installers, macOS archives, Linux checksum files and Windows update assets. It also
runs the existing Windows feed preparation against those downloaded files in the runner's
temporary directory. The job does not create releases, upload release assets or open PRs.

`pnpm run test:acceptance release artifacts --source <merged-artifact-directory>` runs the asset
checks locally. Pass `--inventory <json-file>` to also validate GitHub inventory pages captured
with `gh api --paginate --slurp` for the run's artifacts endpoint. This check reads the supplied
files; it does not install packages or validate native execution. Synthetic negative fixtures
are included in `pnpm run test:acceptance unit`.

Publication requires both build and artifact verification to succeed and remains disabled for
dry runs. The `release` environment retains its existing approval configuration. The publish
job revalidates assets before creating a missing draft release; its existing protection against
updating an already published release remains in effect. A dry run establishes build, artifact
transport and local feed preparation evidence, but not installed application behavior, release
uploads or automated PR creation. Those require their corresponding platform or release checks.

For runner or Action failures, inspect the failing step before changing another part of the
pipeline. Revert only the affected workflow change to a verified, supported runner or Action
commit; retired `macos-14` is not a continuing recovery option. A failed dry run leaves Actions
artifacts but performs no release writes. After a real publication failure, inspect the release
and generated PR state before retrying because writes may already have succeeded.

## Runtime preparation integrity

Standalone runtime preparation downloads Node only from the official distribution and verifies
the selected asset against its official SHA-256 list. Native rebuilds run in an isolated tree;
they never replace the Electron ABI dependencies. Generated runtime replacement checks its owned
manifest and resolved directory before moving or deleting anything. Failed restoration preserves
the previous tree for explicit recovery.

Dependency tracing scopes filesystem reads to the staging root, rejects cross-drive host paths
and external link targets, and requires the target native binaries before materialization.
Optional import warnings are reviewed explicitly; unknown warnings fail preparation.

The Windows-only optional icon extractor has a [const-correctness patch](../../patches/@bitdisaster__exe-icon-extractor@1.0.10.patch) for compilation with the Node 24 toolchain. It changes only the error-message parameter to a read-only pointer. Remove the patch when the dependency includes this correction and a clean Windows install compiles it successfully.

# Build and Package Guide

This guide owns native dependency preparation, application artifacts and runtime integrity. Start with the [development quick start](../development.md#quick-start); run delivery checks only for affected artifacts.

Run commands from the repository root unless a step specifies another directory.

## Native dependency preparation

Native process queries use `@draculabo/sysinfo-process-enhanced`. pnpm installs the matching prebuilt platform package; keep optional dependencies enabled. For a different packaging architecture, install dependencies on the target runner as the release workflow does.

`pnpm install --frozen-lockfile` applies the [Forge 7.11.1 patch](../../patches/@electron-forge__core@7.11.1.patch) through `patchedDependencies`. Forge's package-bin cleanup uses a relative glob with the package directory as `cwd`, so Windows path separators cannot make it scan unrelated workspace profiles. The patch is also applied when lifecycle scripts are disabled. Remove it when the installed Forge version includes this scoped scan and Windows packaging passes with inaccessible directories elsewhere in the workspace.

## Build and package

Run these only when the changed artifact or platform requires them. A successful source build
does not establish installer, native keyring or live-provider behavior.

- `pnpm run package` creates an unpacked application bundle.
- `pnpm run make` creates platform distributables and is slower and more environment-sensitive than packaging.
- `pnpm run audit:size:win32:x64` checks the default Forge output: Squirrel EXE/NuGet and WiX MSI installers have a 200 MiB budget including the standalone runtime; `app.asar` and the uncompressed standalone tree each have an independent 120 MiB budget. The audit selects packaged resources directly and does not scan acceptance profiles elsewhere in `out`. Vite dependency caches under `node_modules/.vite` are excluded from packaging; the production bundles under the root `.vite` remain required.
- Packaging prepares standalone runtime dependencies in an isolated directory. Its `pnpm install --prod --frozen-lockfile --ignore-scripts` uses the same lockfile, pnpm settings and native-build allowlist as development. Native dependencies are rebuilt only in that isolated tree with its bundled Node version; desktop dependencies remain untouched.
- Runtime installation and dependency tracing use separate staging directories. Native-module and command checks run against the traced output before publication. On Windows, publication copies the validated tree after backing up any existing generated runtime, avoiding populated-directory rename failures. A failed copy restores the backup; failed recovery retains its staging directory and reports the recovery path. Forge consumes the output only after publication completes. Other platforms publish by directory rename.

Core, CLI and worker builds embed the JavaScript dependencies listed in
[`standalone-bundled-dependencies.json`](../../scripts/build/standalone-bundled-dependencies.json).
An empty importer chain selects the top-level package for license attribution. The OpenTelemetry
SDK entries resolve their license metadata through the same Sentry dependency chain used by Core,
which can resolve a different version from the desktop SDK.
Tracing retains dependencies still required by external packages, including Fastify's `semver`
dependency. Native modules keep their external loaders and binaries. The standalone tree includes
`THIRD-PARTY-NOTICES.txt` with the embedded dependency versions and license texts from `LICENSE` or
`LICENSE.md`. The published Drizzle package omits its license text, so packaging uses the
checked-in copy from its
[0.45.2 source tag](https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/LICENSE).

The gateway supplies its Fastify adapter explicitly. Bundling `@nestjs/core` lets the standalone
build resolve unused transport branches through the existing aliases. The bundle also includes
Fastify, its Nest adapter and selected routing, plugin and schema compiler dependencies.
The Core build excludes Nest's default Express adapter branch through the same alias mechanism.
UUID generation, the imported Radash helpers and WebSocket support are embedded in the
standalone JavaScript bundles.
`@nestjs/common`, RxJS and Pino resolve from the traced runtime dependency tree. Pino's transport
resolves its worker entry from the installed package directory.

Standalone Core uses the Sentry initializer without default integrations so the bundle can drop
the automatic instrumentation catalog. The bundle embeds Sentry's OpenTelemetry implementation
and shares the external `@opentelemetry/api` with Core code that creates spans.

pnpm applies the [AppImage maker patch](../../patches/@pengx17__electron-forge-maker-appimage@1.2.1.patch)
through `patchedDependencies`, including installations with lifecycle scripts disabled. The patch
preserves the requested x64 or arm64 architecture and paths containing spaces.
Before repacking, the maker restores `0755` on directories that the legacy runtime extracted
with `0700`, so an unprivileged process can traverse the mounted AppImage in Firejail.
Linux AppImage packaging runs the maker's downloaded `appimagetool` with
`--appimage-extract-and-run`, so the build step does not require FUSE libraries or mount
access. Running the installed AppImage still requires a supported AppImage runtime
environment. Remove the patch when the maker includes these behaviors and
`pnpm run test:appimage-download` passes on Linux for both architectures.

Windows NSIS uses an assisted installer in English, Simplified Chinese, Russian, Vietnamese,
French, and Brazilian Portuguese. Interactive installation offers a checked-by-default
**Create a desktop shortcut** option. Users can clear it before installation or select it during
reinstallation to restore a missing shortcut. Start menu shortcuts remain enabled.
Clearing the option during reinstallation preserves an existing desktop shortcut.
Automatic updates skip this page and preserve a missing desktop shortcut. The
`--no-desktop-shortcut` command-line option also suppresses desktop shortcut creation.
Application startup does not display an installation-path warning.

During interactive installation, the native progress page names the current operation and offers
**Show details**. Details list installation steps without exposing individual file paths. A failed
upgrade reports whether setup kept the old version, restored it, or retained a backup for manual
recovery. A failure to create a requested shortcut or remove the staging directory is reported
separately from the result of installing the program.

Each NSIS attempt can write an `installer-*.log` file alongside the desktop and core logs in
`%USERPROFILE%\.antigravity-agent`. The installer writes its own file with the version,
architecture, install mode, stages, timestamps, and outcomes. A recovery location is recorded
only when automatic restoration is blocked. The installer keeps the latest five files during
normal operation and limits each log to 64 KiB. An unavailable log location does not stop
installation. The files stay local. If setup reports a failure and names a log, the user can
retrieve that file directly.

See [installer verification](../testing.md) for build and native update checks.

### Windows NSIS upgrades

The per-user NSIS installer asks before replacing a registered installation when opened directly.
The app's restart-and-install action supplies confirmation for an in-app update. Setup extracts
the full ZIP payload and verifies the required application files and uninstaller in a sibling
directory before moving the installed files. It restores the old directory if activation fails.
If restoration is blocked, setup preserves the backup and displays its location in interactive
mode. Setup keeps account and preference data in their existing profile locations.

The locked `app-builder-lib` patch selects this installation step while retaining the upstream
uninstaller build, signing and registration steps. `make:nsis` verifies the full installer's SHA-512
and records its size in the update metadata. See [Windows updater acceptance](../testing/delivery.md#windows-automatic-updates)
for failure and upgrade checks.

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

### Publish a new version

Dispatch [Release](../../.github/workflows/release.yml) on `main` for a stable release or `beta`
for a prerelease. The workflow previews Semantic Release and builds the candidate's exact
source commit and version. Use `dry_run=true` to rehearse the candidate build and artifact
verification. If there is no new candidate, the workflow ends after planning.

After the build and verification succeed, the publish job enters the `release` environment.
The job records the release commit and tag, creates a draft, and uploads the required assets.
It verifies the uploaded names, sizes and SHA-256 digests before the draft becomes public.
The final edit uses the Actions token so it does not start another packaging run. Stable
distribution updates run after public release. The Windows feed and Linux metadata PR are
updated only for the current stable release.

### Rebuild or repair an existing version

- Dispatch **Publish Release** with `dry_run=true` for installers in Actions Artifacts.
- A Release published manually on GitHub still triggers **Publish Release**. It builds the
  tagged commit and adds missing files. If an existing file has different content, the job fails
  and reports that conflict. This path can leave the release public while attachments are pending.
- To repair an existing release, dispatch **Publish Release** with `dry_run=false` and its
  `release_tag`. Enable `allow_update_published_release` to change files on an already published
  release. These paths write only attachments for the selected version.

### Recover an interrupted official release

- Re-run failed jobs while the original Actions artifacts are available. If the source branch
  advances before the release commit is written, start a release from its new tip.
- If a release commit or tag already exists and the original artifacts are unavailable, dispatch
  **Release** on the original channel with `operation=resume` and the recorded `release_tag`.
  It rebuilds the original source and version and continues the recorded candidate. A draft stays
  private until the full remote asset inventory matches.
- Resolve the current unpublished candidate before releasing another version on that channel.
  To stop pursuing it, dispatch **Release** on the same channel with `operation=abandon` and the
  candidate tag. Abandonment retains the tag and reserves its version. The next release notes
  include changes since the last published, reachable release on that channel. A first beta can
  use the last reachable stable release as its notes baseline.
- Re-run a failed distribution job on its own. It checks that the tag is still the current
  stable release before changing the shared Windows feed or opening a Linux packaging PR.

Run `node --test scripts/release/release-delivery.test.mjs` for the local delivery and recovery
fixtures. Use a six-target dry run to verify packaging and artifact transfer. An isolated
repository exercise is needed to verify the live draft-to-public transition, attachment readback,
and the manually published release trigger. Local fixtures cannot establish those results.

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

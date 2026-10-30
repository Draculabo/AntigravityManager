# Development

This document covers contributor setup and routine commands. Command definitions in [package.json](../package.json) are authoritative; update this document when their purpose or required environment changes.

For repository-local skill ownership, inventory and updates, see [Project Skill Maintenance](development/agent-skills.md).

See [GitHub automation](development/github-automation.md) for check selection, inactive-PR
maintenance, optional Ark issue triage, remote acceptance and recovery.

## Prerequisites

- Node.js `24.22.0` (the version pinned in `.nvmrc`).
- pnpm `10.34.6` (the version pinned in `package.json#packageManager`).
- Git for cloning the repository and contributing changes.
- A supported Electron development environment for the target operating system.
- Native build prerequisites when rebuilding `better-sqlite3`, keyring packages or Electron-native modules.

Use pnpm only for this project. The repository contains `pnpm-lock.yaml`; do not introduce another package manager or lockfile.

After installing the pinned Node version, run `corepack enable` and `corepack install` to activate
the pinned pnpm version. If Corepack is unavailable in your Node distribution, install pnpm
`10.34.6` using its official installation instructions before continuing.

When an install needs to compile a native module, prepare the target platform's toolchain:

| Platform | Native rebuild prerequisites                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows  | Python and Visual Studio's **Desktop development with C++** workload; use tools matching the target architecture. |
| macOS    | Python and Xcode Command Line Tools, which provide Clang and Make.                                                |
| Linux    | Python, Make and a C/C++ toolchain such as GCC; additional system libraries depend on the module being built.     |

These are the baseline [node-gyp requirements](https://github.com/nodejs/node-gyp#installation).
Use the failing dependency's instructions for extra SDK or system-library requirements, and
keep the complete installation error when asking for help.

## Migrating an existing checkout

Use the pinned Node and pnpm versions, then run `pnpm install --frozen-lockfile` from the
repository root. Stop running project processes first; pnpm replaces the previous npm-managed
dependency layout. Do not reuse a copied `node_modules` tree or regenerate the lockfile as an
installation workaround. The migration does not change application profiles or databases.

## Quick start

Run these commands from the repository root after cloning the fork:

Confirm the reported Node.js and pnpm versions satisfy the prerequisites before installing.

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm start
```

Keep dependency lifecycle scripts and optional dependencies enabled. Normal installation applies
the development patch and installs local Git checks. If installation fails, keep the error and
resolve its prerequisite before starting the application; see [environment failures](#environment-failures).

`pnpm start` starts Electron Forge with Vite in development mode. A successful desktop launch opens the application window;
startup and gateway diagnostics appear in the terminal, while renderer diagnostics appear in
Chromium DevTools. Stop the development process when finished.

The default launch can use the normal local profile and saved auto-start settings. It is not an
isolated test profile. Close another runtime using the same profile, protect existing profile
data and use the owning isolated acceptance procedure before testing account switching or other
credential-changing operations. Documentation edits and ordinary local unit tests do not need
provider credentials or a running desktop app.

See [local Git checks](development/git-checks.md#local-git-checks) for hook installation and recovery when lifecycle
scripts were skipped. Do not bypass an installation failure with `--ignore-scripts` as a general fix.

## Choose a development target

| Target                            | Entry and expected result                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop UI or embedded gateway    | `pnpm start` builds and starts the Electron development app. This is the default contribution path.                                                                                                  |
| Standalone core                   | `pnpm run build:core` produces the core build; `pnpm run start:core` starts it with the existing profile configuration. It may start the gateway when saved auto-start is enabled.                   |
| CLI                               | `pnpm run build:cli` builds the CLI. Consult the [runtime architecture](architecture.md#runtime-topology) for its runtime preparation and profile ownership before invoking state-changing commands. |
| Documentation or pure logic tests | Edit the owning document or run the focused test without launching Electron or a provider.                                                                                                           |

The desktop and standalone core share profile ownership. A running owner prevents a second
runtime from opening that profile; see [Architecture](architecture.md#runtime-topology).

## Desktop diagnostics

Development logs from Electron main and the embedded NestJS gateway appear in the main-process console. Renderer logs and React diagnostics appear in Chromium DevTools. `Shift + Click` can jump from a rendered element to source when `code-inspector-plugin` is enabled.

Use [development diagnostics](development/diagnostics.md) for opt-in profiling and connection checks.

## Common commands

Choose checks from [Testing](testing.md#checks-for-a-contribution); this is not a sequence to run
for every contribution. Definitions in [package.json](../package.json) remain authoritative.

| Need                                    | Command                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Run one unit or integration file once   | `pnpm test src/tests/unit/gateway-endpoint-coverage.test.ts` (replace with the owning file) |
| Check TypeScript contracts              | `pnpm run type-check`                                                                       |
| Check code style                        | `pnpm run lint`                                                                             |
| Check changed Markdown                  | `pnpm exec prettier --check CONTRIBUTING.md` (name the changed files)                       |
| Check documentation and agent contracts | `pnpm run check:agent-contracts`                                                            |

- `pnpm test` runs the Vitest unit and integration suite once.
- `pnpm run test:e2e` runs Playwright against the Electron application.

`pnpm run format` and `pnpm run format:write` scan the entire workspace; the latter writes
changes. For a focused PR, name only changed files with `pnpm exec prettier --check` or intentionally
use `pnpm exec prettier --write` on those paths, then review the diff. Do not format unrelated
untracked trees.

Additional inspection and governance tools:

- `pnpm run change-scope` prints a versioned, read-only Git change report. Pass explicit `--base` and `--head` revisions when comparing commits; it never fetches or changes Git state.
- `pnpm run analyze:imports` prints the Git-tracked TypeScript/JavaScript import graph. Runtime closure ignores type-only imports.
- `pnpm run verify:boundaries` reports renderer, preload, shared and root-IPC boundary violations without failing the command. `pnpm run verify:root-ipc-boundary` enforces the clean root-router rule today; `pnpm run verify:boundaries:enforce` is reserved for a clean overall baseline and exits non-zero on any violation.
- `pnpm run verify:type-boundaries` compares production type-boundary violations with the checked-in baseline. Regenerate that baseline only as an explicit, reviewed policy update with `node scripts/verify-type-boundaries.mjs --write-baseline`.
- `pnpm run check:governance` runs governance contracts, harness-script tests, runtime boundaries and the type-boundary baseline gate. CI runs it before static and unit checks.

## Change workflow

1. Inspect the owning module, nearby tests and the nearest `AGENTS.md` before editing.
2. Identify whether the change crosses renderer, preload, IPC, main, server, persistence or external protocol boundaries.
3. Make the smallest complete change and preserve unrelated worktree changes.
4. Run focused evidence first, then add broader checks only for affected surfaces.
5. Report the commands actually run and any platform, credential or environment coverage that remains unverified.

## Build and package

Use the [build and package guide](development/build-and-package.md) for native dependencies, packaging and runtime integrity.

## Local Git checks

Use [Local Git checks](development/git-checks.md#local-git-checks) for installation, automatic gates, evidence limits and recovery.

## Nix integration

Use the [Nix guide](development/nix.md#nix-integration) for pinned packages, overlays and development shells.

## Specialized acceptance

Find existing checks and their effects in the [script guide](../scripts/README.md). Read
[script instructions](../scripts/AGENTS.md) and the owning procedure before running native,
installer or live-account checks. Those checks can consume quota, change local state or need
platform tools; they are separate from first-run setup.

### Live Schema acceptance

Schema replay, controlled-client checks and live provider/history/retry acceptance are documented
in [Schema conversion](modules/proxy-gateway/schema-conversion.md#diagnostics-and-acceptance).
The [live workflow](modules/proxy-gateway/schema-conversion.md#live-schema-acceptance) defines
its prerequisites, privacy limits and required cleanup.

## Release notes

Use [Release tooling](development/release-tooling.md#release-notes) for generation, preview and publication requirements.

## Generated and derived files

- Do not edit `src/routeTree.gen.ts` manually.
- Do not commit generated application packages, installers, coverage output or local performance recordings unless a repository workflow explicitly owns them.
- Generated assets must be recreated through the owning script and reviewed with their source inputs.

## Environment failures

When a required command fails because of sandbox, credential, native-module, GUI or network restrictions, preserve the original command and capture the concrete failure. Retry with the narrowest permitted environment change only after the failure identifies that boundary. Do not reinterpret a genuine test failure as an environment problem.

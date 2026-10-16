# Development

This document covers contributor setup and routine commands. Command definitions in [package.json](../package.json) are authoritative; update this document when their purpose or required environment changes.

## Prerequisites

- Node.js `>=22.14.0`.
- npm `>=10`.
- Git for cloning the repository and contributing changes.
- A supported Electron development environment for the target operating system.
- Native build prerequisites when rebuilding `better-sqlite3`, keyring packages or Electron-native modules.

Use npm only. The repository contains `package-lock.json`; do not introduce another package manager or lockfile.

When an install needs to compile a native module, prepare the target platform's toolchain:

| Platform | Native rebuild prerequisites                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows  | Python and Visual Studio's **Desktop development with C++** workload; use tools matching the target architecture. |
| macOS    | Python and Xcode Command Line Tools, which provide Clang and Make.                                                |
| Linux    | Python, Make and a C/C++ toolchain such as GCC; additional system libraries depend on the module being built.     |

These are the baseline [node-gyp requirements](https://github.com/nodejs/node-gyp#installation).
Use the failing dependency's instructions for extra SDK or system-library requirements, and
keep the complete installation error when asking for help.

## Quick start

Run these commands from the repository root after cloning the fork:

Confirm the reported Node.js and npm versions satisfy the prerequisites before installing.

```powershell
node --version
npm --version
npm ci
npm start
```

Keep dependency lifecycle scripts and optional dependencies enabled. Normal installation applies
the development patch and installs local Git checks. If installation fails, keep the error and
resolve its prerequisite before starting the application; see [environment failures](#environment-failures).

`npm start` starts Electron Forge with Vite in development mode. A successful desktop launch opens the application window;
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

| Target                            | Entry and expected result                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop UI or embedded gateway    | `npm start` builds and starts the Electron development app. This is the default contribution path.                                                                                                  |
| Standalone core                   | `npm run build:core` produces the core build; `npm run start:core` starts it with the existing profile configuration. It may start the gateway when saved auto-start is enabled.                    |
| CLI                               | `npm run build:cli` builds the CLI. Consult the [runtime architecture](architecture.md#runtime-topology) for its runtime preparation and profile ownership before invoking state-changing commands. |
| Documentation or pure logic tests | Edit the owning document or run the focused test without launching Electron or a provider.                                                                                                          |

The desktop and standalone core share profile ownership. A running owner prevents a second
runtime from opening that profile; see [Architecture](architecture.md#runtime-topology).

## Desktop diagnostics

Development logs from Electron main and the embedded NestJS gateway appear in the main-process console. Renderer logs and React diagnostics appear in Chromium DevTools. `Shift + Click` can jump from a rendered element to source when `code-inspector-plugin` is enabled.

Use [development diagnostics](development/diagnostics.md) for opt-in profiling and connection checks.

## Common commands

Choose checks from [Testing](testing.md#checks-for-a-contribution); this is not a sequence to run
for every contribution. Definitions in [package.json](../package.json) remain authoritative.

| Need                                    | Command                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Run one unit or integration file once   | `npm test -- src/tests/unit/gateway-endpoint-coverage.test.ts` (replace with the owning file) |
| Check TypeScript contracts              | `npm run type-check`                                                                          |
| Check code style                        | `npm run lint`                                                                                |
| Check changed Markdown                  | `npx prettier --check CONTRIBUTING.md` (name the changed files)                               |
| Check documentation and agent contracts | `npm run check:agent-contracts`                                                               |

- `npm test` runs the Vitest unit and integration suite once.
- `npm run test:e2e` runs Playwright against the Electron application.

`npm run format` and `npm run format:write` scan the entire workspace; the latter writes
changes. For a focused PR, name only changed files with `npx prettier --check` or intentionally
use `npx prettier --write` on those paths, then review the diff. Do not format unrelated
untracked trees.

Additional inspection and governance tools:

- `npm run change-scope` prints a versioned, read-only Git change report. Pass explicit `--base` and `--head` revisions when comparing commits; it never fetches or changes Git state.
- `npm run analyze:imports` prints the Git-tracked TypeScript/JavaScript import graph. Runtime closure ignores type-only imports.
- `npm run verify:boundaries` reports renderer, preload, shared and root-IPC boundary violations without failing the command. `npm run verify:root-ipc-boundary` enforces the clean root-router rule today; `npm run verify:boundaries:enforce` is reserved for a clean overall baseline and exits non-zero on any violation.
- `npm run verify:type-boundaries` compares production type-boundary violations with the checked-in baseline. Regenerate that baseline only as an explicit, reviewed policy update with `node scripts/verify-type-boundaries.mjs --write-baseline`.
- `npm run check:governance` runs governance contracts, harness-script tests, runtime boundaries and the type-boundary baseline gate. CI runs it before static and unit checks.

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

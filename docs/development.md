# Development

This document covers contributor setup and routine commands. Command definitions in [package.json](../package.json) are authoritative; update this document when their purpose or required environment changes.

## Prerequisites

- Node.js `>=22.14.0`.
- npm `>=10`.
- A supported Electron development environment for the target operating system.
- Native build prerequisites when rebuilding `better-sqlite3`, keyring packages or Electron-native modules.

Use npm only. The repository contains `package-lock.json`; do not introduce another package manager or lockfile.

## Common commands

Schema replay uses `npm run test:schema:replay -- <audit-database-path>` with a Node runtime that
provides `node:sqlite` (Node 22.17+ for this acceptance tool). It requires read access to the audit
database and its SQLite sidecars, and writes only compiled replay code to a temporary directory.
Results with no intact tool/output Schema samples do not satisfy the real-data gate. See the
[Schema reference](proxy-schema-conversion.md) for selection and privacy requirements.

Controlled Schema acceptance also offers `test:schema:client` with an installed Claude Code
executable and `test:schema:sentry` after `prepare:standalone`. Both use loopback receivers and
synthetic authentication; provider connectivity and remote Sentry delivery remain separate gates.

### Live Schema acceptance

Acceptance output under `artifacts/` is local workspace data and is ignored by Git. Generate it with the workflows below; referenced execution records are available only in the workspace where those checks ran.

`node scripts/acceptance/schema/run-client-matrix.mjs [all|codex|opencode|claude]` runs the installed
Windows clients through the default gateway and real Flash upstream. It requires the prepared
standalone runtime, an unowned stopped profile and usable accounts. Each client uses isolated
temporary settings and a new probe file; the loopback relay forwards original request bytes,
replaces synthetic credentials privately and buffers bounded responses to reject unsafe tool
instructions. Codex uses a temporary stdio MCP tool that reads only the fixed probe; its Windows
Shell execution-policy failures remain separate failed evidence. OpenCode permits reads and
searches, with the relay enforcing the fixed-file target; Claude Code declares default tools and
the inspected credential-free local MCP servers. Successful provider responses are never
simulated. The gate requires an actual tool-result continuation, a matching final answer and
correlated successful upstream attempts for every request. Recovered failures remain visible
in anonymous evidence. Cleanup must restore the stopped state, preserve saved settings and
remove the owned temporary profiles. This workflow consumes quota and writes only aggregate
evidence under `artifacts/schema-work-package/live-results`; it does not perform a separate
remote Sentry receipt check or calibrate budgets from organic traffic. Run
`node --test scripts/acceptance/schema/check-client-matrix.mjs` for its protocol, guard, continuation
and audit evidence controls.

After `npm run prepare:standalone`, use `npm run test:schema:live -- gemini-3.1-pro-high` to test
ordinary and degraded tool parameters against the real gateway and Google upstream. The harness
also exercises current native Gemini Flash/Pro routes and installed Claude Code's Read tool.
Use `npm run test:schema:live -- gemini-3.7-flash-high` for ordinary/degraded Flash tool loops;
this is also the default model. The explicit `gemini-3-flash` option retains the retired-route
failure probe. A provider retirement notice does not count as a successful tool call. It requires an
unowned stopped profile, existing usable accounts, enabled desktop reporting preferences and
configured Sentry credentials. The bundled read-only Sentry helper requires `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG` and `SENTRY_PROJECT`; values are resolved in memory from the shell/build environment.

This command consumes provider quota and sends controlled diagnostic events to the configured
remote Sentry project. Newly created probe files are the only allowed tool targets. It starts
the core temporarily and shuts it down afterward, without saving proxy auto-start or client
settings. Loopback observation relays forward the real client requests and SDK envelopes to
their configured destinations; only bounded anonymous evidence is written under
`artifacts/schema-work-package/live-results`. A single failed cycle makes the command fail.
Ordinary acceptance also fails when remote Sentry receipt cannot be confirmed; an outbound
envelope or HTTP 200 alone is insufficient. The relay records anonymous transport status to
distinguish delivery failures from event-query failures.

Append `client-mcp` to use default Claude Code declarations and the three inspected credential-free
local MCP servers. This verifies actual declaration acceptance and a controlled Read cycle;
it does not execute MCP business tools. Append `history` to acquire two real parallel calls and
compare combined, adjacent and reversed-result histories without rewriting production history.
Append `history extended` to compare identical resubmissions and bidirectional Pro/Flash
continuation, choosing the source model in the first argument. Append `history recovery` to
mutate only signatures in a controlled history and require final result matches plus actual
upstream 400/200 attempts for one gateway request. A provider accepting the mutation does not
prove recovery and keeps this check failing. Audit evidence retains anonymous scenario labels
and per-request attempt counts. `node scripts/acceptance/schema/check-history-evidence.mjs`
checks missing-result sensitivity and private audit-context exclusion using isolated fixtures.
`node scripts/acceptance/schema/run-core-startup.mjs 5` isolates the prepared core's readiness
and shutdown without submitting gateway requests or intentional diagnostic events. It requires
an unowned stopped profile and restores that state; forced cleanup fails the command. Append
`trace` for fixed test-owned preload markers separating process entry and the first event-loop
turn. Only anonymous counts and timings are retained. The acceptance readiness window matches
the production CLI's 45 seconds and bounds stalled probes.
`node --test scripts/acceptance/schema/check-startup-evidence.mjs` compares a controlled slow
start with the production launcher and verifies timeout/exit failure sensitivity.
Append `client` to rerun a diagnosed client failure independently; this does not replace the
full cycle record. Append `2.5.5` or `1.23.2` for an isolated User-Agent build experiment, or
`production` for a transient backup-endpoint-only experiment. These modes identify themselves
in the result and do not alter production routing, version selection or saved configuration.

`node scripts/acceptance/schema/run-live-retry.mjs <network|rotation|incomplete|all> [gemini-3.7-flash-high|gemini-3.1-pro-high]`
starts the prepared core with a temporary loopback relay. Network mode resets the first
controlled continuation connection; rotation mode returns 503 for both addresses on the
first account. Successful generations use the real provider. Incomplete mode injects a
disclosed thought-only unary fragment on the initial tool request, then requires a real
streamed tool turn and all result continuations. It never supplies successful tool calls.
The gate correlates audit attempts within one gateway request, compares preserved contents,
excludes private identities and requires stopped-state restoration with unchanged saved
settings. Natural rate limits or other extra attempts keep the strict scenario failing.
Network/rotation modes provide supplementary fault coverage; default-primary tool/result
acceptance does not require a successful backup-endpoint probe. See the
local scope record (`artifacts/schema-work-package/retry-verification.md#acceptance-scope`).
`node --test scripts/acceptance/schema/check-retry-evidence.mjs` checks injection, forwarding,
audit discrimination and privacy sensitivity using isolated fixtures.

`node scripts/acceptance/schema/verify-remote-event.mjs <event-id> <test-release>` reads the exact
remote event and emits only closed diagnostic fields and privacy booleans. A nonempty stored
user context keeps the strict privacy check failing even when receipt is confirmed. See the
[security reference](security.md#schema-diagnostics-and-node-reporting).

```powershell
npm install
npm start
npm run type-check
npm run lint
npm run format
npm run check:governance
npm run change-scope -- --base origin/main --head HEAD
npm run analyze:imports
npm run verify:boundaries
npm run verify:type-boundaries
npm test
npm run test:e2e
npm run package
npm run make
```

- `npm start` starts Electron Forge with Vite in development mode.
- The renderer development server binds to `127.0.0.1` so Electron can reach it even when IPv6 loopback is blocked. Forge supplies the actual port to the main process; its readiness probe bypasses proxy environment settings and times out each request after one second.
  Run `npm run test:acceptance -- development connection` to verify the Vite listener and Forge URL with an isolated Electron window. This check does not open account storage or launch the gateway.
- Native process queries use `@draculabo/sysinfo-process-enhanced`. npm installs the matching prebuilt platform package; keep optional dependencies enabled. No Rust build is needed in this repository. For a different packaging architecture, install dependencies on the target runner as the release workflow does.
- `npm test` runs the Vitest unit and integration suite once.
- `npm run test:e2e` runs Playwright against the Electron application.
- `npm run package` creates an unpacked application bundle.
- `npm run make` creates platform distributables and is slower and more environment-sensitive than packaging.
- The release publisher installs the locked project dependencies in its own job with `npm ci --include=dev --ignore-scripts --no-audit --no-fund`. It requires the JavaScript acceptance dispatcher and YAML parser, but processes prebuilt artifacts without downloading Electron or rebuilding native modules. Update-feed checks run before release creation or asset upload.
- `npm run audit:size:win32:x64` checks the default Forge output: Squirrel EXE/NuGet and WiX MSI installers have a 200 MiB budget including the standalone runtime; `app.asar` and the uncompressed standalone tree each have an independent 120 MiB budget. The audit selects packaged resources directly and does not scan acceptance profiles elsewhere in `out`. Vite dependency caches under `node_modules/.vite` are excluded from packaging; the production bundles under the root `.vite` remain required.
- Packaging prepares standalone runtime dependencies in an isolated directory. Its `npm ci` preserves the package URLs in `package-lock.json` with `--replace-registry-host=never`, so a local npm mirror setting cannot redirect locked official-registry downloads to an unavailable mirror archive. Dependency versions, integrity checks and global npm configuration remain unchanged.
- Runtime installation and dependency tracing use separate staging directories. Native-module and command checks run against the traced output before publication. On Windows, publication copies the validated tree after backing up any existing generated runtime, avoiding populated-directory rename failures. A failed copy restores the backup; failed recovery retains its staging directory and reports the recovery path. Forge consumes the output only after publication completes. Other platforms publish by directory rename.
- `npm ci` applies the [Forge 7.11.1 development patch](../patches/@electron-forge+core+7.11.1.dev.patch) through `postinstall`. Forge's package-bin cleanup uses a relative glob with the package directory as `cwd`, so Windows path separators cannot make it scan unrelated workspace profiles. If dependencies were intentionally installed with `--ignore-scripts`, run `npm run postinstall` before packaging. The isolated production runtime does not run Forge or installation hooks. Remove the patch when the installed Forge version includes this scoped scan and Windows packaging passes with inaccessible directories elsewhere in the workspace.
- `npm run change-scope` prints a versioned, read-only Git change report. Pass explicit `--base` and `--head` revisions when comparing commits; it never fetches or changes Git state.
- `npm run analyze:imports` prints the Git-tracked TypeScript/JavaScript import graph. Runtime closure ignores type-only imports.
- `npm run verify:boundaries` reports renderer, preload, shared and root-IPC boundary violations without failing the command. `npm run verify:root-ipc-boundary` enforces the clean root-router rule today; `npm run verify:boundaries:enforce` is reserved for a clean overall baseline and exits non-zero on any violation.
- `npm run verify:type-boundaries` compares production type-boundary violations with the checked-in baseline. Regenerate that baseline only as an explicit, reviewed policy update with `node scripts/verify-type-boundaries.mjs --write-baseline`.
- `npm run check:governance` runs governance contracts, harness-script tests, runtime boundaries and the type-boundary baseline gate. CI runs it before static and unit checks.

Run one unit test with:

```powershell
npm test -- src/tests/unit/example.test.ts
```

Run one E2E test with:

```powershell
npm run test:e2e -- src/tests/e2e/app.spec.ts
```

Use [testing.md](testing.md) to select checks according to the affected behavior. Do not run packaging, the complete E2E suite or every local check by reflex when a narrower test proves the changed path.

## Change workflow

1. Inspect the owning module, nearby tests and the nearest `AGENTS.md` before editing.
2. Identify whether the change crosses renderer, preload, IPC, main, server, persistence or external protocol boundaries.
3. Make the smallest complete change and preserve unrelated worktree changes.
4. Run focused evidence first, then add broader checks only for affected surfaces.
5. Report the commands actually run and any platform, credential or environment coverage that remains unverified.

## Generated and derived files

- Do not edit `src/routeTree.gen.ts` manually.
- Do not commit generated application packages, installers, coverage output or local performance recordings unless a repository workflow explicitly owns them.
- Generated assets must be recreated through the owning script and reviewed with their source inputs.

## Desktop diagnostics

Development logs from Electron main and the embedded NestJS gateway appear in the main-process console. Renderer logs and React diagnostics appear in Chromium DevTools. `Shift + Click` can jump from a rendered element to source when `code-inspector-plugin` is enabled.

Sentry is enabled only when the relevant build configuration and credentials are present. Absence of Sentry in a local build is not evidence that the instrumentation path is broken.

React Scan is opt-in and development-only. Enable it for one local Electron session with:

```powershell
$env:ANTIGRAVITY_ENABLE_REACT_SCAN = '1'
npm start
```

Vite injects the diagnostic before the renderer entry only in that mode; production builds and CI do not reference it. When enabled, the current React Scan package performs its own version check against `react-grab.com`, so do not enable it in a development environment where that outbound request is prohibited.

Performance recording and local update-feed helpers live in `scripts/` and have dedicated npm commands. Use them only when the task concerns those paths; some operations create local artifacts or require platform-specific binaries.

## Environment failures

When a required command fails because of sandbox, credential, native-module, GUI or network restrictions, preserve the original command and capture the concrete failure. Retry with the narrowest permitted environment change only after the failure identifies that boundary. Do not reinterpret a genuine test failure as an environment problem.

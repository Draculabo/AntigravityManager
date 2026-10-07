# Testing Strategy

Select evidence according to the behavior a change can affect. Focused tests are the normal local default; exhaustive suites and platform matrices belong in CI or an explicitly requested full rehearsal.

## Evidence principles

- A passing command is evidence only for paths it executes.
- Prefer user-visible output, persisted state, protocol output or another stable observable over private call sequences.
- New validation scripts and regression tests must be capable of failing for a representative violation.
- Never weaken assertions, skip checks or narrow coverage solely to make a failure disappear.
- Report only checks that actually ran; report blocked or unavailable evidence separately.

## Change-to-evidence matrix

| Changed surface                       | Minimum local evidence                                                | Add when applicable                                                        |
| ------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Pure utility, mapper or codec         | Owning Vitest file                                                    | Adjacent tests for a shared type or caller contract                        |
| React component or hook               | Owning Testing Library/Vitest file                                    | Focused E2E for navigation, preload or multi-window behavior               |
| Route definition                      | Related component test and `npm run type-check`                       | Focused Playwright flow for user navigation changes                        |
| ORPC schema or handler                | Owning handler/router test and `npm run type-check`                   | Renderer consumer test when the result or error contract changes           |
| Preload bridge                        | `preload-sandbox.test.ts`, affected IPC test and `npm run type-check` | Focused Electron E2E when exposure or lifecycle changes                    |
| Electron main lifecycle               | Owning startup, window, tray or process tests                         | Focused E2E; package when bundled runtime behavior changes                 |
| SQLite repository or codec            | Owning database/persistence tests                                     | Backup, restore, migration or durability tests for format changes          |
| Credential or security behavior       | Credential-store and sensitive-data tests                             | Migration and platform-specific evidence when storage providers change     |
| Proxy request/response mapper         | Owning protocol mapper and streaming tests                            | Real-path parity or controller integration tests                           |
| Gateway controller/service            | Owning integration and endpoint-coverage tests                        | E2E or live-provider evidence only when the external provider path changes |
| Packaging, updater or native artifact | Owning packaging/update tests                                         | `npm run package`, size audit or platform build when artifacts change      |
| Documentation or agent governance     | `npm run check:governance` and formatting                             | Link/build checks owned by the affected documentation system               |

For cloud-account plaintext storage, run the focused mock tests with `npm test -- --run
src/tests/unit/convert-encrypted-account-fields.test.ts
src/tests/unit/cloud-account-batch-writer.test.ts`. The real SQLite reopen and old-ciphertext backup
test needs the installed Electron ABI on Windows:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& .\node_modules\electron\dist\electron.exe .\node_modules\vitest\vitest.mjs run src/tests/unit/cloud-account-plaintext-persistence.test.ts
```

`npm run check:governance` analyzes the current worktree, including untracked source files and unstaged deletions, and enforces every runtime boundary rule. It is not a report-only check.

## Native process queries

After changing Windows client shutdown, run `node scripts/acceptance/accounts/test-windows-graceful-close.integration.mjs`
on Windows. It runs production stop logic against temporary WinForms windows and verifies that
normal close flushes an in-memory buffer while a cancelled close leaves the process alive.
The fixture uses a scoped observer and does not prove official IDE conversation persistence.
For official IDE evidence, prepare the isolated Windows account-switch profile, build the
acceptance helpers, and run `node scripts/acceptance/accounts/test-official-ide-history.integration.mjs`.
Close other IDE profiles first. The check submits a unique test marker, verifies the exact
reply, uses production normal close/relaunch, and opens the same history entry by its captured identifier.
Its sanitized report separates normal close, restart and conversation restoration; a
successful close does not by itself establish conversation persistence.
Run the same harness with `--switch-accounts` to verify A → B → A using the prepared
isolated account pair. It checks credential readback, Google identity and official IDE
identity at each switch, reopens the same conversation, stops the isolated service and
restores the original shared Windows credential. Run `--during-generation` separately
to verify the visible generation cancel control immediately before normal close. It captures
two actual response excerpts and separately checks their presence in the official conversation
SQLite `steps.step_payload` before close, after relaunch, and in the reopened official UI.
The database checks are read-only and apply to the inspected IDE 2.5.5 schema; they do not
migrate or modify official data. Use the prepared standalone Node executable matching the
native SQLite build. Add `--extended-close` only for a separate 60-second diagnostic;
the standard harness budget remains 15 seconds and the production default is unchanged.
Reports distinguish a missing history entry from missing persisted response text.
The official history picker collapses each group to four entries. The harness expands
`fastpick-show-more-*` options and enumerates only `fastpick-item-*` entries before comparison;
show-more controls are not conversations.
These modes write separate sanitized reports under `out/account-switch-acceptance`.
The native launch harness separately verifies that windowless Windows fixtures are refused;
its forced cleanup targets only disposable fixture processes.

The published `@draculabo/sysinfo-process-enhanced` dependency provides read-only process
queries. After `npm ci`, run `node scripts/test-sysinfo.integration.mjs`.
Run the same script under Electron with `ELECTRON_RUN_AS_NODE=1` to verify native loading
and real process metadata. The check uses a dedicated temporary child with spaces,
Unicode, quotes, empty argv and trailing backslashes; it does not target installed apps.
The existing Antigravity launch integration script verifies the production observer on
native Windows, Linux and optionally WSL Windows interop.

After changing native dependency or packaging configuration, run `npm run package`.
Forge forces native module rebuilding for its Electron target. A preceding standalone Node build
can replace a binary even when cached Electron rebuild metadata remains present. Verify the actual
packaged loader; a successful Forge exit code alone does not establish ABI compatibility.
Verify the main package remains inside `app.asar`, its matching platform binary exists
under `app.asar.unpacked/node_modules/@draculabo`, and the packaged loader can query a
real process under Electron. The existing AutoUnpackNatives plugin unpacks `.node` files.

## Type and React quality gates

`npm run verify:type-boundaries` blocks new production `any`, double assertions, native `fetch`, direct JSON assertions and `@ts-ignore` entries against `.agents/type-boundary-baseline.json`. Test, mock and generated sources are excluded. A controlled third-party adapter exception must be local, time-bounded and name its owner, tracking issue and reason.

React Doctor runs in pull requests with changed-line scope and error blocking. Telemetry, score sharing and supply-chain analysis are disabled. A full scan is advisory and establishes the existing-work baseline. React Scan is injected only for an explicitly enabled development Electron session; it is not bundled or run in CI.

### Desktop workspace checks

Run `npm run test:performance -- desktop-workspace.spec.mts` to check the production shell,
account page and Traffic Monitor in an isolated Electron window with synthetic data. The check
covers light/dark screenshots, supporting theme-color text contrast, a 900-pixel window, keyboard selection, proxy-dialog focus return,
navigation state, sidebar preference restoration and Chinese copy. Screenshots are saved in the
test output directory. The fixture has no real preload, credentials, database or upstream service;
this evidence does not establish installer behavior or macOS/Linux native integration.

The [desktop interface reference](desktop-interface.md) owns the presentation conventions.

Run `npm run test:performance -- feedback-workspace.spec.mts` to check deferred reads, empty account
and traffic views, failed reads with retry, and all four notification variants in isolated Electron.
It verifies visible close controls, keyboard dismissal, reduced motion and a 900-pixel window.
Read results and notification content are synthetic; reporting issues and authorization are not
performed. The focused traffic-feedback unit check additionally verifies that a failed background
refresh retains previously loaded records until retry succeeds.

Run `npm run test:performance -- settings-workspace.spec.mts` to check proxy configuration and
settings in the same isolated fixture. It covers keyboard tab and disclosure navigation, retained
tool-panel disclosure state, masked connection keys, start-confirmation focus return, protocol
selection, the settings theme switch and layout at 900 pixels. Screenshots include both themes
and narrow windows. This check does not start the proxy, save tool configuration, patch clients
or use real account data.

Run `npm run test:performance -- dialog-workspace.spec.mts` to check account sign-in, import/export
dialog dismissal, batch deletion cancellation, traffic-row keyboard activation and request details.
It verifies focus return, manual-code reset, translated status and metadata, retry after a failed
read, unavailable records, body selection, editor theme and a narrow detail window. Data and read failures are
synthetic; this check does not perform Google authorization, delete accounts or copy credentials.

Run `npm run test:performance -- tool-dialog-workspace.spec.mts` to check device information,
local account import preview, tool setup and configuration previews, and cache confirmation in a 900-by-700 Electron window.
It checks address validation, retry after synthetic read failures, scrolling with visible footer
actions, cancellation focus, focus return and a dark configuration preview. It does not change
device information, write tool settings, clear caches or use the system clipboard. Focused unit
checks exercise pending-action guards, local import cancellation and partial cache results.

### Renderer update profiling

Run `npm run test:performance -- renderer-updates.spec.mts` to measure account-page and
Traffic Monitor updates in isolated Electron windows. The fixture renders production
components with React Compiler and React Profiler, using 100 synthetic accounts and 50
synthetic traffic records. It has no production preload, database or provider connection.

The scenarios cover single-account selection, login input, account model availability,
statistics changes, queued traffic notifications on an older page and search input.
Component invocation counts are the regression gate. Profiler render durations are
diagnostic values from the local development renderer, not production latency guarantees.
Reports are written under `test-results/playwright-performance`.

For an optional Git comparison, set `AGM_RENDERER_PROFILE_BASELINE` to the commit to compare
before running the same command. The harness loads the relevant baseline source in memory;
it does not switch branches or modify the worktree. Run it again after changes to the account
selection store, account availability selector or Traffic Monitor state boundaries.

## Preload traffic events under Content Security Policy

Run `npm run test:acceptance -- runtime preload-csp --policy-timing initial` and
repeat with `--policy-timing after-preload`. The check builds the production preload
through Forge's Vite configuration and launches a real Electron window using the
current main-window execution settings in a temporary profile. It verifies that
the page rejects dynamic compilation, delivers 100 valid traffic events in order,
updates the visible count, filters invalid events, and stops callbacks after unsubscribe.
All temporary window/profile/build files are removed; sanitized reports remain under `out`.

Use `--expect-regression` only against the unfixed preload to confirm the same native
check detects event loss and compilation errors. A successful Node VM or Vitest check
does not replace this Electron evidence. The fixture uses synthetic events and does
not prove live-provider requests, the full Traffic Monitor React page, or installer behavior.

Run `preload-traffic-events.test.ts`, `preload-sandbox.test.ts`, and
`browser-window-security.test.ts` for the adjacent unit contracts.

## Focused commands

`cloud-account-plaintext-persistence.test.ts` exercises real SQLite account deletion, current-account
reference cleanup at startup, repeat deletion, unrelated-setting preservation and transaction rollback
using disposable databases. Run it with `cloud-account-settings-store.test.ts`,
`cloud-account-adapter.test.ts`, `core-rpc.test.ts` and `convert-encrypted-account-fields.test.ts`
for the adjacent desktop and standalone contracts. When the workspace SQLite binary was rebuilt
for Electron, run the same Vitest entry with the matching Electron executable and
`ELECTRON_RUN_AS_NODE=1`; do not rebuild it for Node over the desktop binary just to run these tests.
This establishes native persistence behavior, not installed-client sign-out or live-provider requests.

Build and acceptance scripts are organized by responsibility; see the
[script reference](../scripts/README.md) for directory ownership and prerequisites.
Run `npm run test:acceptance -- unit` for the pure Node harness tests. It exercises local fixtures and
protocol/report logic without live accounts, provider requests, application windows or installers.
`check:ci` and `test:all` include this check. Native, installed and live acceptance remain separate
explicit commands because they require matching native binaries, platform artifacts or prepared accounts.

For coding tool configuration, run `agent-tools.test.ts`, `cli-agent-tools.test.ts`,
`agent-tool-sync-card.test.ts`, `opencode-model-sync-dialog.test.ts`, `opencode-installation.test.ts`
and `service-config.test.ts`. They cover file recovery, secret projection, write failure, selection,
CLI confirmation and shutdown dependencies. Also run `core-rpc.test.ts` and
`gateway-adapter.test.ts` when the selected-owner wiring changes. Build core and CLI after
changing the TOML dependency. These checks do not replace real installed-client requests;
report platform and upstream evidence separately using the [SOP](live-agent-acceptance.md).

Run a specific Vitest file:

```powershell
npm test -- src/tests/unit/<behavior>.test.ts
```

Run tests matching a name:

```powershell
npm test -- -t "<behavior>"
```

Run a focused Playwright file:

```powershell
npm run test:e2e -- src/tests/e2e/<flow>.spec.ts
```

Run the real Windows command-shell smoke test for the performance recorder launcher:

```powershell
npm run test:performance-recorder-process
```

This process-level test uses a temporary `npm.cmd` fixture and runs outside Vitest's `no-app-launch` guard. It skips on non-Windows platforms; the default Vitest suite validates only the launch-command contract and does not start child processes.

After `npm run start` has built the production traffic-audit and Thought Store workers, run their
native SQLite persistence checks under Electron's matching Node runtime:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& .\node_modules\electron\dist\electron.exe scripts\acceptance\runtime\traffic-audit-native.test.mjs
```

This checks real worker messages, database reopen, body paging, retention and physical disk
reclamation. It supplements, but does not replace, live gateway/provider acceptance.

After `npm run build:core`, check the standalone core's built audit and Thought Store workers:

```powershell
npm run test:acceptance -- runtime diagnostics --smoke
```

This checks both emitted worker entries, real SQLite initialization, empty statistics and
shutdown. Run it with a `better-sqlite3` binary matching the executing Node ABI. Desktop
dependencies rebuilt for Electron do not establish plain Node compatibility. Use an isolated
copy of `dist/core` with the same dependency version and a matching native binary rather than
rebuilding the desktop dependency tree. Passing this smoke does not establish database reopen,
retention, terminal owner drain, installer delivery or compatibility on other operating systems.

For the SQLite worker shutdown primitive, run:

```powershell
npm run test:unit -- --run src/tests/unit/sqlite-worker-shutdown.test.ts
```

This uses real Node worker threads with an in-memory test protocol. It covers admission closure,
accepted-command drain, concurrent closes, missing acknowledgements, termination failure and
forbidden restart. It does not open SQLite or validate terminal feature-service/profile teardown.

For terminal diagnostic-store admission and core ownership ordering, run:

```powershell
npm run test:unit -- --run src/tests/unit/diagnostic-store-shutdown.test.ts src/tests/unit/core-shutdown.test.ts src/tests/unit/gateway-start.test.ts
```

These tests cover lazy stores with no gateway, admitted serialization/SSE finish/Thought hydration,
no worker recreation, both-store cleanup and lease retention after failure. Service worker mocks
supplement the real-thread primitive tests; they do not establish native SQLite, packaged Electron
or the desktop forced-exit timing under production load.

For IPC audit metadata/context and desktop admission/drain behavior, run:

```powershell
npm run test:unit -- --run src/tests/unit/ipc-audit-recorder.test.ts src/tests/unit/ipc-capture.test.ts src/tests/unit/ipc-capture-capacity.test.ts src/tests/unit/core-rpc.test.ts src/tests/unit/desktop-shutdown.test.ts
```

The capacity test sends logical bodies at 100 MiB minus one byte, exactly 100 MiB and one byte
above the limit, checking stored prefixes, full digests and completion accounting without retaining
the entire output in the persistence substitute. Private-endpoint tests cover large session/model
metadata and the existing sanitized error snapshot. These checks do not measure whole-process RSS.

After `build:core`, run the native diagnostic-service lifecycle check with a matching Node SQLite
binary. It also writes and reopens prepared remote-capture bodies through the real service/worker;
the separate private-endpoint tests exercise transport with substituted persistence. Neither check
establishes installed desktop cutover or full-core process ownership.

The optional runtime root selects an isolated installation of the same locked native
dependency version; omitting it uses the workspace dependency tree.

```powershell
npm run test:acceptance -- runtime diagnostics --runtime-root C:\matching-node-runtime
```

The launcher reuses the core Vite configuration and Electron-import rejection to build a test-only
service entry beside that runtime, then copies the built SQLite worker entries. Its child process
isolates `os.homedir()` before application imports. It opens real databases in the temporary home,
checks audit redaction and IPC completion, closes both stores terminally, rejects old-owner reuse
and reopens persisted audit/Thought/signature records through fresh owners. An oversized logical
body also verifies the real SQLite stored prefix, full digest and partial flag after reopen. The
child has a 60-second deadline for this capacity case. Generated files are
removed only inside the verified temporary directory. It does not start a gateway, management
server or complete core process, access keyring credentials, or validate remote IPC/installer flows.

Run static checks when a shared type, import surface, public export or cross-module contract changes:

```powershell
npm run type-check
npm run lint
npm run format
```

For desktop owner selection, run the owning bootstrap, management IPC, launcher and desktop
shutdown tests. After `build:core`, the process acceptance command is:

```powershell
npm run test:acceptance -- runtime bootstrap --runtime-root C:\matching-node-runtime
```

This starts the built standalone core in an isolated home with matching native SQLite, verifies
remote adapter operations and capture, preserves an external attachment, waits for terminal lease
release and reopens persisted audit records. The presentation process has fail-fast SQLite, keytar
and Worker sentinels. The core uses a disposable in-memory keytar substitute; the check never
accesses the real OS credential store. It executes the desktop bootstrap composition under Node,
not Electron windows or an installer. Platform packaging, real OS keyrings and live providers
remain unverified by this command. Child processes have bounded cleanup, and generated files are
removed only from the verified temporary directory.

## Standalone delivery acceptance

For live provider task acceptance across standalone CLI and Electron owners on Windows and Linux,
follow [Live agent acceptance](live-agent-acceptance.md). The runner records a bounded audit and
token report for a real file-writing task; a successful HTTP response alone does not pass the task.

`npm run package` prepares the standalone resource tree as part of Forge packaging. For a local
verification build, set `AGM_PACKAGE_OUTPUT` to an isolated output directory and
`AGM_DISABLE_SENTRY_UPLOAD=1` to suppress build-time source-map upload. Release defaults are unchanged.
Preparation requires the target platform and architecture to match the native build host.

`node --test scripts/build/trace-standalone-runtime.test.mjs` checks exclusion of host assets and retention
of required native entries through the actual dependency tracer.

Run `npm run test:acceptance -- runtime installed <packaged-resources>/standalone` against the actual resources.
The check copies them outside the repository and removes Node search-path overrides. It verifies
SQLite WAL/read/write/reopen, real OS credential create/read/update/delete across process restarts,
both workers, core owner bootstrap, representative remote adapters, gateway start/stop and its
unauthenticated rejection, external attachment, shutdown, persisted reopen, owned-process crash
recovery and stale-epoch rejection. The whole-run timeout accommodates four cold starts and three
terminal drains; individual production startup and shutdown deadlines remain unchanged.
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

On Windows, `npm run test:acceptance -- runtime desktop <packaged-desktop-executable>` opens real packaged
Electron windows in an isolated profile. It checks embedded and remote startup, settings navigation,
preference restart, packaged CLI service lifecycle, external-core retention and process crashes.
It snapshots and restores only the application's Windows login settings. The actual desktop uses
the normal application keyring service; run this check only with explicit authorization for the host.
It does not install or upgrade the application. Installer recovery and other operating systems
remain separate acceptance requirements.

The Windows desktop check records main-process working set and peak working set, plus idle core
working set, in `artifacts/runtime24-desktop-memory.json`. These are individual process observations,
not the total Electron renderer/process-group memory.

On an explicitly authorized Windows host, run `npm run test:acceptance -- installers msi <current-msi>` under
the normal user token. It refuses an already registered product or upgrade family, installs into
an isolated directory, removes one owned worker, verifies exact Windows Installer repair, and runs
the native and real-window checks against the installed resources. It uninstalls only verified test
product identities, checks their registration is gone, and restores previous application shortcuts
and login settings. The existing Squirrel installation registration must remain unchanged.

For a cross-version fixture, `npm run make:msi-upgrade-fixture -- <packaged-app> <new-out-subdirectory>`
uses the configured WiX maker with the previous patch version. Supply that MSI as the second argument
to `test:acceptance -- installers msi`. The check requires identical upgrade families, different product codes and
x64 metadata, verifies the old product is removed, and preserves an external profile fixture during
upgrade. Both installers contain the current application payload; this verifies installer mechanics,
not historical application/database migration. Existing MSI releases with random upgrade identities
and Squirrel-to-MSI migration are not covered by this fixture.
WiX cleans the previous installation directory during upgrade; user profiles must remain outside
that directory. The profile fixture checks this actual layout, not retention of unmanaged install files.

For an existing Squirrel installation, copy its `Update.exe`, root executable, icon, `packages`
directory and versioned app directory into a dedicated directory directly under the OS temporary
directory, with the copied install root named `antigravity_manager`. Then run
`npm run test:acceptance -- installers squirrel-upgrade <authentic-install> <temporary-copy> <squirrel-feed>`.
The feed must contain the current `RELEASES` and full `.nupkg`. The check verifies selected source
and copy hashes, updates only the copy from authentic 0.19.0 through its copied `Update.exe`, and
runs the installed native and real-window checks against the updated app. It snapshots and restores
the application's Squirrel registration, shortcuts and login settings and removes only the verified
temporary fixture after success. An external profile marker survives the update. This establishes
Squirrel package compatibility on the host; it does not replace the user's installed app or prove
historical account/database migration, an in-place rollback or a Squirrel-to-MSI transition.

For Windows updater changes, run the package-selection unit test and
`npm run test:acceptance -- installers feed`. Build the NSIS installer from the same Forge packaged app with
`npm run make:nsis -- x64 <packaged-app>`; the script checks its installer against the generated
`latest-nsis-x64.yml`. An installed NSIS A-to-B check must exercise a local feed, automatic `.exe`
download, an explicit restart action, the relaunched version and an external profile marker.
`npm run make:nsis-update-fixture -- <packaged-app> <unused-out-directory>` makes the previous
patch-version installer from the same application payload for that check.
`npm run test:acceptance -- installers nsis-updater <previous-installer> <current-installer> <current-latest-yml>`
installs the fixture on an authorized Windows x64 host, checks the app's automatic update and
restores its shortcuts and login settings. Run it only from a disposable Windows account: the
installer's automatic relaunch uses that account's default app profile, even when the previous
process had a temporary profile argument. The check refuses an existing default NSIS installation
or app profile.
The packaged Squirrel in-app updater check (`npm run test:acceptance -- installers squirrel-updater`) also
requires a disposable Windows account with no existing app profile because its installer
relaunch may drop the temporary user-data argument.
Check a missing feed, an interrupted download and a tampered installer separately. Packaging
and feed tests alone do not establish installed updater behavior or cross-architecture acceptance.

For release-note changes, run the focused `src/tests/unit/release-notes-*.test.ts` tests and
`npm run type-check`. They cover publication-text serialization, exact-tag fallback and response
validation, IPC target/link validation, Markdown/image behavior, download-time inspection, empty
and retry states, dialog version identity and cancellation of late responses. The existing manual
update and external-URL policy tests cover surrounding behavior. These tests do not prove a live
GitHub publication, native browser launch, or installed updater acceptance.

Run `npm run preview:release-notes` for an isolated Electron window using the production update
notice, dialog, renderer IPC client and preload. Its controls select complete Markdown, empty
content, one failure followed by retry, a delayed response, and available/downloading/downloaded
notifications. Download and install actions are simulated; the fixture does not load accounts,
start the gateway or install updates. Toggle its theme and resize the window to inspect scrolling
and footer actions. Close the window to stop its local renderer server.

`npm run preview:release-notes -- --live --tag v0.23.0` uses the production resolver against that
published GitHub tag, including metadata validation and exact-tag fallback. Specify another
published tag when needed. The interface defaults to Chinese; `--language en` selects English.
If a shell wrapper drops npm's forwarded arguments, run
`node scripts/preview-release-notes.mjs --live --tag v0.23.0` directly. The terminal reports the
selected mode and tag, then confirms when the visible window is ready. It remains running until
that window closes.

`npm run test:performance -- release-notes.spec.mts` runs the repeatable isolated Electron checks
through production preload and real MessagePort IPC, including native request cancellation,
scrolling, themes, empty content and retry. Set `AGM_RELEASE_NOTES_LIVE_TAG` to a published tag
to include the opt-in live resolver check. Screenshots are written under
`test-results/playwright-performance`. This evidence does not establish installed updater behavior
or GitHub Actions publication of new assets.

## Proxy-gateway coverage

The proxy gateway exposes several compatibility surfaces. Select tests by protocol and behavior rather than running every proxy test automatically:

- Request and response conversion: the owning OpenAI, Anthropic or Gemini mapper tests.
- Streaming changes: streaming mapper/state, malformed-stream and stream-error tests.
- Tool behavior: tool mapper, namespace and custom tool-call tests.
- Model routing: model availability, alias agreement and routing-policy tests.
- Retry, quota and account leasing: the owning policy/service tests.
- Public endpoint changes: endpoint coverage, controller integration and real-path parity tests.
- Durable Responses behavior: response/session store and durability tests.

When a change affects both streaming and non-streaming paths, test both. When it changes externally visible protocol output, prefer exact object or event-sequence assertions over checking individual fields independently.

## Persistence and security coverage

Changes to SQLite, keyring adapters, credential migration, backups or serialized payloads require the owning focused tests and a failure-path test for corrupt, unavailable or unsupported stored data when that boundary can occur at runtime.

Do not add hostile-input tests to same-process values that TypeScript fully constrains. Do add them at JSON, IPC, file, database, process and external API boundaries.

## Full rehearsal

Use the full local approximation when the user requests it, when diagnosing CI, or when a change is genuinely repository-wide:

```powershell
npm run check:ci
npm run test:e2e
```

Packaging and distributable generation are separate evidence. Run `npm run package` or `npm run make` only when build configuration, native dependencies, packaged paths, update behavior or artifacts can be affected.

## Environment-dependent evidence

The Antigravity launch regression has an isolated native process check, separate from Vitest's no-app-launch guard:

```bash
node scripts/test-antigravity-launch.integration.mjs
node scripts/test-antigravity-launch.integration.mjs --wsl-interop
```

Run the first command with Windows Node.js or Linux Node.js and a C compiler. The second uses Linux Node.js in WSL and the installed Windows .NET Framework C# compiler. Both create a temporary fixture and exercise production launch, process observation and stop code. Native Windows copies the Node executable into the fixture directory and performs three consecutive launch/close cycles. Each main process has one utility host with seven same-executable workers: client-process arguments, TypeScript-style `--useNodeIpc`, and workers without known helper arguments are covered. It verifies that only the main process confirms startup, all nine processes exit on the first close request, and each cycle dispatches exactly one launch. Linux and WSL interop check one launch/close cycle. All modes check argv round trips and no reopening after close. Discovery is restricted to the fixture's full executable path; no installed Antigravity is started or closed. Windows execution needs permission to query and terminate the fixture processes. This evidence does not replace real account-switch acceptance, desktop acceptance with the official `.deb` or macOS Launch Services.

For desktop acceptance, use an isolated Manager configuration and application home directory, a fresh main/renderer build, and the real process IPC. In WSLg, configure the extracted Linux executable explicitly to select native process observation; use an isolated XDG handler registration when reproducing the old URI behavior. Verify the actual application window as well as process confirmation, loading and disabled controls, busy errors, invalid executable errors, confirmation timeout without retry, path conflicts before close, and no reopening after manual close. Record the exact OS and official application versions. An extracted `.deb` with a profile-local handler does not establish system-wide installer or GNOME acceptance; account credential injection and macOS Launch Services need separate evidence.

Some Electron, OS keyring, native-module, live-provider, update and packaging paths depend on platform capabilities or credentials. Record the exact skipped evidence and why. A focused test passing with mocked Electron or keyring modules does not prove the corresponding native integration.

## Client credential storage checks

The focused `client-account-write.test.ts`, `snapshot-credentials.test.ts`, `account-backup-file.test.ts`, `database-backup-keys.test.ts` and account handler suites cover destination routing, preflight, preserved topic rows, missing projects, primary-store failures, encrypted snapshot round trips and historical snapshot input. Credential-store and CLI suites cover native readback and required file failures. `antigravityVersion.test.ts` covers version caching, coalescing, metadata changes and probe deadlines.

`node scripts/test-client-account-write.integration.mjs` exercises real SQLite transactions under Electron on Windows and Node on Linux/macOS with isolated synthetic credentials. It verifies WAL-aware backups, repeated writes to one captured destination, A-to-B-to-A restoration, unchanged client recovery files and full transaction rollback on an injected primary-write failure. Windows additionally exercises the production Win32 credential adapter with exact-target A-to-B-to-A writes, independent keytar enumeration and repeated nondestructive reads. Only the credential target is redirected to a unique synthetic target; CLI and Google file writes are suppressed for this native adapter check, and its test credential is deleted during cleanup. For Linux validation from Windows, install Linux native dependencies in an isolated directory and set `AGM_CLIENT_NATIVE_DEPS` to that directory; Windows native modules cannot validate the Linux path.

These fixtures do not write live OS credentials or prove official-client account identity. Release acceptance still requires two authorized test accounts, real IDE switching with the mode selected from its service structure, Classic restart switching, CLI identity checks and a real AI request after each switch. Supervised-service hot switching preserves the same window/workspace; machine-service fallback must confirm full shutdown and one restart. Confirm that a closed window is not reopened and a failed local confirmation is not reported as successful. Physical macOS and system-wide Linux desktop acceptance require separate runs.

## IDE hot-switch lifecycle checks

For real cloud and local account A-B-A checks through the CLI and Electron owners, follow the [account switching acceptance tutorial](account-switch-acceptance.md). It distinguishes official login confirmation from credential-only evidence and records the Linux restart-only limitation.

`node scripts/test-ide-hot-switch.integration.mjs` exercises the production process selector and service lifecycle against isolated native binaries on Windows, Linux and macOS. Three account-marker changes verify two AI services below direct and utility-host parents, replacement credentials, stable main-process identity, continued terminal progress and an unchanged in-memory workspace. Discovery and cleanup are restricted to the generated fixture directory. Run with the native platform dependency installed; do not reuse Windows-only `node_modules` for a Linux check.

The focused `ide-hot-switch.test.ts` and `runtime-switch.test.ts` suites cover identity reuse, deadlines, partial writes, fallback and user-closed windows. They also verify that a directly owned machine AI service selects the full-restart path without terminating it during preflight, and that the captured IDE closes before account writes and receives exactly one launch. These checks do not replace official IDE UI account-switch acceptance or establish readiness of real AI requests. A workspace service replacing a machine service with the same binary is not recovery. Live process-only termination on official IDE 2.5.5 in Windows and WSL leaves the machine service absent; WSL additionally reproduces a real chat request to its dead endpoint. Bare-metal Linux and macOS remain unverified.

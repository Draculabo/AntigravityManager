# Client Runtime Testing

This reference selects process, credential and switch evidence. Use the [account-switch tutorial](account-switch-acceptance.md) for authorized live-account execution and [client security](security.md) for recovery constraints.

Run commands from the repository root unless a step specifies another directory.

The focused `antigravity-process-identity.test.ts` and `runtime-observer.test.ts` suites reject
third-party tool names, product text in unrelated folders/arguments and unreadable tool metadata.
They retain supported binary names, configured/captured executable identity and genuine competing
installations for conflict checks. `windows-normal-close.test.ts` covers targeted native window
requests, access-denied codes, missing windows, enumeration failure and native resource cleanup.
`process-failure-diagnostics.test.ts` checks the resulting closed evidence through Sentry projection
and sanitized logs; `cloud-account-switch-owner.test.ts` and `core-rpc.test.ts` verify desktop/core
failure transport and that close failure stops credential writes.

## Native process queries

### Window close and official history

After changing Windows client shutdown, run `node scripts/acceptance/accounts/test-windows-graceful-close.integration.mjs`
on Windows. It runs production stop logic against temporary WinForms windows and verifies that
normal close flushes an in-memory buffer for visible and hidden windows, while a cancelled close
leaves the process alive. Native Windows uses PID-scoped `WM_CLOSE` requests for unowned
top-level windows; owned save/confirmation dialogs remain under the client's control.
The focused `runtime-stop.test.ts` cases also cover slow initial native Windows observations
and forbid posting close after the operation deadline. Startup slow-observation and late-result
cases belong to `runtime-launch.test.ts`; neither operation extends its overall deadline.
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

### Process query dependency

The published `@draculabo/sysinfo-process-enhanced` dependency provides read-only process
queries. After `pnpm install --frozen-lockfile`, run `node scripts/test-sysinfo.integration.mjs`.
Run the same script under Electron with `ELECTRON_RUN_AS_NODE=1` to verify native loading
and real process metadata. The check uses a dedicated temporary child with spaces,
Unicode, quotes, empty argv and trailing backslashes; it does not target installed apps.
The existing Antigravity launch integration script verifies the production observer on
native Windows, Linux and optionally WSL Windows interop.

### Packaged process loader

After changing native dependency or packaging configuration, run `pnpm run package`.
Forge forces native module rebuilding for its Electron target. A preceding standalone Node build
can replace a binary even when cached Electron rebuild metadata remains present. Verify the actual
packaged loader; a successful Forge exit code alone does not establish ABI compatibility.
Verify the main package remains inside `app.asar`, its matching platform binary exists
under `app.asar.unpacked/node_modules/@draculabo`, and the packaged loader can query a
real process under Electron. The existing AutoUnpackNatives plugin unpacks `.node` files.

## Native launch and desktop acceptance

The Antigravity launch regression has an isolated native process check, separate from Vitest's no-app-launch guard:

```bash
node scripts/test-antigravity-launch.integration.mjs
node scripts/test-antigravity-launch.integration.mjs --wsl-interop
```

Run the first command with Windows Node.js or Linux Node.js and a C compiler. The second uses Linux Node.js in WSL and the installed Windows .NET Framework C# compiler. Both create a temporary fixture and exercise production launch, process observation and stop code. Native Windows copies the Node executable into the fixture directory and performs three consecutive launch/close cycles. Each main process has one utility host with seven same-executable workers: client-process arguments, TypeScript-style `--useNodeIpc`, and workers without known helper arguments are covered. It verifies that only the main process confirms startup, all nine processes exit on the first close request, and each cycle dispatches exactly one launch. Linux and WSL interop check one launch/close cycle. All modes check argv round trips and no reopening after close. Discovery is restricted to the fixture's full executable path; no installed Antigravity is started or closed. Windows execution needs permission to query and terminate the fixture processes. This evidence does not replace real account-switch acceptance, desktop acceptance with the official `.deb` or macOS Launch Services.

For desktop acceptance, use an isolated Manager configuration and application home directory, a fresh main/renderer build, and the real process IPC. In WSLg, configure the extracted Linux executable explicitly to select native process observation; use an isolated XDG handler registration when reproducing the old URI behavior. Verify the actual application window as well as process confirmation, loading and disabled controls, busy errors, invalid executable errors, confirmation timeout without retry, path conflicts before close, and no reopening after manual close. Record the exact OS and official application versions. An extracted `.deb` with a profile-local handler does not establish system-wide installer or GNOME acceptance; account credential injection and macOS Launch Services need separate evidence.

## Client credential storage checks

The focused `client-account-write.test.ts`, `snapshot-credentials.test.ts`, `account-backup-file.test.ts`, `database-backup-keys.test.ts` and account handler suites cover destination routing, preflight, preserved topic rows, missing projects, primary-store failures, encrypted snapshot round trips and historical snapshot input. Credential-store and CLI suites cover native readback, required file failures and isolation of the local CLI session from other operating-system environments. `antigravityVersion.test.ts` covers version caching, coalescing, metadata changes and probe deadlines.

`node scripts/test-client-account-write.integration.mjs` exercises real SQLite under Electron on Windows and Node on Linux/macOS with isolated synthetic credentials. Windows and Linux verify WAL-aware backups, repeated writes to one captured destination, A-to-B-to-A restoration, unchanged client recovery files and full transaction rollback on an injected primary-write failure. The Mac branch verifies sequential writes, root-level ID-token input, unchanged unrelated cache/auth rows, project removal and retained earlier statements after a later failure; it does not invoke Keychain. Windows additionally exercises the production Win32 credential adapter with exact-target A-to-B-to-A writes, independent keytar enumeration and repeated nondestructive reads. The credential target is redirected to a unique synthetic target and deleted during cleanup. Mocked CLI and Google destinations verify that an Agy switch does not change that host credential on Windows and Linux. For Linux validation from Windows, install Linux native dependencies in an isolated directory and set `AGM_CLIENT_NATIVE_DEPS` to that directory; Windows native modules cannot validate the Linux path.

`macos-client-account-chain.test.ts` compares complete command arguments, three cache files
and SQLite protobuf bytes against synthetic contract fixtures. It covers deletion/create
ordering, long tokens, seconds/milliseconds expiry, root ID tokens, mirror failures, existing
database fallback, partial SQLite writes, refresh-token-only reads and Agy confirmation.
The fixtures record the expected encoded payloads, file contents and database entries.
Isolated synthetic files and a command recorder validate data and command compatibility;
these checks do not execute the real macOS `security` tool, its access prompts
or POSIX permission changes. The native SQLite check on Windows establishes byte and
statement compatibility only, not Mac runtime acceptance.

These fixtures do not write live OS credentials or prove official-client account identity. Release acceptance still requires two authorized test accounts, real IDE switching with the mode selected from its service structure, Classic restart switching, CLI identity checks and a real AI request after each switch. Supervised-service hot switching preserves the same window/workspace; machine-service fallback must confirm full shutdown and one restart. Confirm that a closed window is not reopened. On macOS, best-effort database fallback can return success despite failed injection, so verify the actual client account rather than relying on the notification. Physical macOS acceptance must cover A-B-A through both CLI and Electron owners, Keychain permissions, the three local mirrors and real AI requests. System-wide Linux desktop acceptance requires a separate run.

## IDE hot-switch lifecycle checks

For real cloud and local account A-B-A checks through the CLI and Electron owners, follow the [account switching acceptance tutorial](account-switch-acceptance.md). It distinguishes official login confirmation from credential-only evidence and records the Linux restart-only limitation.

`node scripts/test-ide-hot-switch.integration.mjs` exercises the production process selector and service lifecycle against isolated native binaries on Windows, Linux and macOS. Three account-marker changes verify two AI services below direct and utility-host parents, replacement credentials, stable main-process identity, continued terminal progress and an unchanged in-memory workspace. Discovery and cleanup are restricted to the generated fixture directory. Run with the native platform dependency installed; do not reuse Windows-only `node_modules` for a Linux check.

The focused `ide-hot-switch.test.ts` and `runtime-switch.test.ts` suites cover identity reuse, deadlines, partial writes, fallback and user-closed windows. They also verify that a directly owned machine AI service selects the full-restart path without terminating it during preflight, and that the captured IDE closes before account writes and receives exactly one launch. These checks do not replace official IDE UI account-switch acceptance or establish readiness of real AI requests. A workspace service replacing a machine service with the same binary is not recovery. Live process-only termination on official IDE 2.5.5 in Windows and WSL leaves the machine service absent; WSL additionally reproduces a real chat request to its dead endpoint. Bare-metal Linux and macOS remain unverified.

### Classic terms retention

The classic-terms-switch suite runs the production switch flow against real temporary official
and history files. It covers A-B-A-B retention, loss during close, missing first consent,
installation revision invalidation, corrupted history, observed standard/GCP changes, profile
isolation, concurrent reopening/settings writes, invalid JSON, durable write failure and field-only
rollback. Existing cloud-account, local-owner, runtime-switch, credential-write and switch-guard
suites cover the call sites. Native macOS/Linux behavior is unchanged and explicitly excluded
from the Windows retention path. See [live acceptance](account-switch-acceptance.md#diagnose-repeated-classic-terms)
for manual first consent, repeated switches and restart evidence.

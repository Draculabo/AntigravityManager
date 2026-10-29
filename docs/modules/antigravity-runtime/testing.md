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

### Windows source-build acceptance evidence

On 2026-10-27, the current main/preload/worker and renderer source build passed the Electron
account owner matrix: Classic and IDE each completed cloud A-B-A and local-snapshot A-B-A.
The runner invokes the renderer's real MessagePort/IPC transport and verifies stored token
ownership, live Google identity and official-client authentication. This establishes the desktop
transport and account lifecycle, not a card-button interaction test or installer acceptance.
The run used Node 24.22.0 and Electron 37.10.3, with the prepared upstream proxy configuration.
Both matrices restored the exact shared Windows credential; Electron login startup settings were
also restored and compared with their baseline.

The official IDE retained an existing real test conversation across normal close/relaunch and
cloud A-B-A. The check opened the same history-entry identifier and verified its exact persisted
reply before and after each transition. The owner stopped and the shared credential was restored.
A separate attempt to create a new test reply failed before history verification because the
official service rejected the request with an unsupported-location precondition. Existing-history
retention therefore passes. A fresh CLI/Core build on 2026-10-28, after correcting proxy environment
forwarding to the detached Core, passed one new Gemini 3.8 Flash High reply through the configured
proxy. The observer attributed Cloud Code CONNECT requests to the language server, official logs
contained no unsupported-location precondition, and configuration, credentials and process cleanup
were verified. This does not establish provider eligibility for every account or exit address.
Interruption during generation remains unverified. These checks do not establish recovery of
unsaved content after forced termination.

Source desktop acceptance must use the Forge main/preload build configuration. A generic Vite
web build can replace main-process runtime environment access and select a different credential
destination. Retain artifact hashes and compare an isolated source copy with the current source
before attributing a failed acceptance run to production behavior.

### Window close and official history

After changing Windows client shutdown, run `node scripts/acceptance/accounts/test-windows-graceful-close.integration.mjs`
on Windows. It runs production stop logic against temporary WinForms windows and verifies that
normal close flushes an in-memory buffer for visible and hidden windows, while ordinary stop
leaves a cancelled close alive. It then invokes the switch-only policy against that refusing
window and confirms forced exit without claiming the unsaved buffer was flushed.
Native Windows uses PID-scoped `WM_CLOSE` requests for unowned
top-level windows; owned save/confirmation dialogs remain under the client's control.
The focused `runtime-stop.test.ts` cases also cover slow initial native Windows observations
and forbid posting close after the operation deadline. Startup slow-observation and late-result
cases belong to `runtime-launch.test.ts`; neither operation extends its overall deadline.
Windows runtime confirmation (including WSL) allows fifteen seconds for two cold observations
and stable process identity; native Linux/macOS retain six seconds. The launch fixture's WSL
process stays alive beyond the complete verification budget so natural exit cannot impersonate
forced cleanup. Deadline failures still dispatch only one launch.
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

Windows IDE uses the selected profile's state database, including IDE 2.6. Verify its UnifiedStateSync OAuth row and fresh official account confirmation; a successful local write alone is insufficient. Isolated A/B acceptance must keep both instances running, stop and restart only A, and verify B remains alive and authenticated. Compare the shared `gemini:antigravity` credential before and after to reject accidental standalone-store writes. Check official provider-populated user status after normal shutdown has flushed the database; the seeded minimal status cannot establish acceptance. The inspected 2.6 client can authenticate and populate account status without persisting a renewed short-lived access token into the original OAuth row, so that row's expiry alone is not an identity or refresh-success check. See [workspace runtime ownership](../workspace/runtime.md) for scope and recovery rules.

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

## Agy binary patch compatibility

Executable format recognition is separate from patch compatibility. The core recognizes PE,
ELF and Mach-O containers and selected architectures. The x64 matcher uses bounded PE or
ELF PIE sections and Go pc/line metadata to identify `Manager.userInputLoop` and
`AuthStatus.EligibilityError`. It requires a direct call, a nil-error test and a conditional
jump to the local `Eligibility Check` UI block. Only that six-byte jump is replaced; the error
function and authentication paths are unchanged. Missing, ambiguous or unfamiliar layouts fail
before writing. The previous global x86 byte signature is removed because it matched unrelated
stream-error handling in official Windows 1.1.2. ELF sections must agree with load-segment
mappings. For the verified Linux PIE layout, relative relocations identify Go module data and
its text bounds; the Go text base can differ from the ELF `.text` start. Missing or ambiguous
relocations are rejected rather than replaced with a guessed base.

The following evidence was collected on 2026-10-25 and 2026-10-26. Executable SHA-256 values and the target
analysis are recorded in the [patch decision](../../../.agents/notes/implemented/bug-fix/2026-10-25-agy-patch-build-diagnostics.md).

| CLI build                            | Established evidence                                                                                                                                                      | Limits                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Official Windows x64 1.4.7           | One intended branch; exact six-byte replacement; file-service backup, idempotence, `--version` startup and exact restoration on an independent copy                       | No live conversation or server-side eligibility verification                                 |
| Installed Windows x64 1.3.6          | Same file-service and startup checks on an independent copy                                                                                                               | Installed artifact identity only; no official archive verification or live conversation      |
| Official Linux x64 glibc 1.4.7       | Native file-service patching in WSL Ubuntu with Node 24.22.0; exact six-byte replacement, executable permissions, backup, idempotence, rejection, startup and restoration | No Linux Electron UI, musl/ARM64 build, bare-metal installer or live conversation validation |
| Official Windows x64 1.1.2           | Rejected; the old signature identifies `SendSideQuestion.func2`, not the input-loop eligibility gate                                                                      | Its older inline eligibility layout is not implemented                                       |
| Official macOS ARM64 1.1.2           | One existing ARM64 match; exact four-byte buffer replacement and idempotence                                                                                              | No native macOS execution or codesigning                                                     |
| Official macOS ARM64 1.0.4 and 1.1.9 | Rejected by existing ARM64 rules                                                                                                                                          | No native execution                                                                          |

Other Windows/Linux builds require the same semantic checks; version strings alone do not establish
compatibility. The new matcher does not implement x86 Mach-O or non-PIE ELF layouts. Native
macOS patch acceptance is unverified. See the [recovery guide](../../upgrade-guides/next/agy-binary-patch.md)
before reusing a CLI that an older Manager reported as patched.

On 2026-10-26, a fresh main/preload/renderer build was exercised in Electron 37.10.3 on Windows
with an empty, isolated account profile and real IPC. Settings-page actions verified a disabled
patch button for an empty path, persisted CLI paths, successful 1.4.7/1.3.6 patching, exact backups,
six-byte-only changes and repeated-operation notifications without another write. Windows
1.1.2 displayed the rejection, SHA-256 and no-write explanation; the input and directory remained
unchanged, and the patch button recovered. The run recorded no renderer page errors. Backups
were restored, the desktop closed, Windows login settings were restored and checked, and the
isolated profile was removed. This source-build check does not establish installer behavior or
a live conversation with an ineligible account.

The Linux file-service check runs on WSL2 Ubuntu x64, kernel `6.6.87.1-microsoft-standard-WSL2`,
glibc `2.35`, with the production service bundled from the current source. It copies the official
CLI into an owned Linux `/tmp` directory and isolates its HOME/XDG paths. Original, patched
and restored `--version` invocations all report `1.4.7`. File mode `0751` survives replacement.
A deliberately altered input-loop symbol is rejected while preserving that input, the existing
backup and the directory listing. The runner restores original bytes and removes its own
directory; it does not modify an installed CLI, credentials or the downloaded source artifact.

The file service reports missing or ambiguous patterns with the source SHA-256 and the existing
error code before backup or replacement. Its "No executable or backup was changed" statement
applies only to this preflight rejection. Preserve the digest with the CLI version, architecture,
installation source and exact error when reporting a build. Treat the digest as file identity,
not proof of its authenticity or compatibility. Do not infer support from a version number or
recommend a downgrade without matching real-build evidence.

Run `pnpm test src/tests/unit/agy-binary-patch.test.ts src/tests/unit/agy-pe-eligibility.test.ts src/tests/unit/agy-elf-eligibility.test.ts`
for the owning checks. Their minimal PE/ELF/Go fixtures establish target relationships, rejection
of the old false positive, bounded parsing and relocation resolution, idempotence and file-service behavior. They do not
establish support for an additional real CLI build. Real-build acceptance
requires verified artifacts, semantic confirmation of the target branch, exact changed-byte
verification and independent file copies. Retain unique-match rejection, unknown-build rejection,
idempotence and backup/recovery checks. Static matching or a successful byte replacement alone
does not establish a working account conversation. The Windows file-service checks execute only
`--version` in an isolated profile, restore from their own backup, verify the original bytes and
remove their independent copies. They do not change the installed CLI or account state.

## IDE hot-switch lifecycle checks

### Classic hot-switch recovery

`classic-hot-switch` tests installation-owned descendants, actual retirement, new identities,
reused PIDs, unsupported platforms, stale ancestry, denied termination and independent restart
ownership. `classic-switch-recovery` injects failures at preparation, consent capture, initial
write/readback, retirement, reassertion, replacement and consent confirmation through the production
coordinator. It verifies one restart, post-exit reconciliation, one final account update, uncertain
startup without another dispatch, and retention of both failures when recovery fails.

`classic-terms-switch` includes a negative case where the official writer still records the previous
account after service replacement. The live client must synchronize its own record; the Manager
does not rewrite that file during hot switching. `switch-trace-diagnostics`, local/cloud owner,
correlated diagnostic and sanitized-log tests cover the complete attempt timeline, recovered warning,
local owner/RPC/IPC preservation, privacy and reporting failure isolation.

These synthetic checks do not establish official account acceptance. The running-client mode of
the [account acceptance runner](account-switch-acceptance.md) records whether the captured main
process identity survived each switch. Combine this with the trace outcome, official identity,
genuine consent and provider-task evidence; a preserved main or new service PID alone is insufficient.

On Windows Classic 2.23.0, the initial native run retained the previous account's consent slot on
both cloud and local B switches, despite fresh services and target credential readback. Its two
B results were partial, and original credentials and the owner were restored. That negative result
owns the consent-confirmation recovery regression; it is not a successful hot-account acceptance.

After the fix, the Windows Classic 2.23.0 CLI/Core owner passed cloud A-B-A and local-snapshot
A-B-A: all six transitions confirmed official identity and durable consent. On Classic 2.27.0,
after manual completion of the updated official consent dialog for each account, the Electron
37.10.3 source build also passed all six transitions through real IPC. The same-account local
transition retained the captured main; cross-account transitions used full restart. The desktop
run restored the exact Windows credential, login startup settings and desktop preferences.

A separate Classic 2.27.0 CLI/Core provider run confirmed official identity and four fresh AI
replies: initial A, same-account A with the main preserved, B after restart and A after restart.
Each unique reply marker was absent before submission and present in the actual response.
The client and owner stopped, and the original Windows credential was restored exactly.
This provider run preceded the final recovery-ownership timeout and diagnostic-only refinements;
focused regression checks and the final desktop run cover those refinements.

The real Sentry SDK passed nine localhost-receiver fixtures in each of standalone Node and
embedded Electron, including complete recovered and terminal switch traces after normalization.
These checks establish local SDK projection and privacy, not remote Sentry delivery. Final process
sampling checks isolated client/service/desktop/Core cleanup. Installer acceptance and native
Linux/macOS hot switching remain unverified; unsupported hot layouts retain the restart route.

On 2026-10-28, the real Windows x64 Forge package passed native standalone runtime acceptance,
including SQLite, synthetic OS-credential CRUD, Core lifecycle and crash recovery. The packaged
runtime hashes match the independently tested preparation output. Real packaged Electron passed
embedded/standalone startup, settings navigation and reopen, CLI lifecycle, external-owner retention
and desktop/Core crash recovery. Packaged operation diagnostics passed through embedded desktop,
standalone Core and CLI. Login settings and production master-key identities were preserved.

The configured WiX maker produced a 188.73-MiB MSI after the identical package was copied to a
shorter owned path; WiX 3 rejected a 264-character source path in the initial output directory.
Administrative extraction preserved the existing 0.26.0 product registration and matched the
versioned executable, ASAR, Core, CLI and runtime-manifest hashes. This does not establish registered
installation, repair, upgrade or uninstall; those checks require a host without an existing product
in the same family. Direct execution of the extracted versioned payload passed embedded desktop,
standalone Core and CLI diagnostic acceptance with unchanged production keys and restored login
settings. The same versioned MSI payload passed all six Classic cloud and local-snapshot A-B-A
transitions with confirmed official identity. The same-account local hot switch retained the main;
cross-account transitions restarted it. The shared client credential, login settings and isolated
desktop preferences were restored and compared with their baselines.

This package does not pass the complete size gate: its ASAR is 121.50 MiB against the 120-MiB
budget. The standalone runtime is 117.63 MiB against 120 MiB. The ASAR includes an existing
September `dist/assets` tree and `dist/tsconfig.tsbuildinfo`; together they account for more than
the 1.50-MiB excess. A clean-input package needs separate verification before claiming that this
failure is resolved. The budget is unchanged, and Squirrel/NSIS installers are not selected here.

### Discovery and switch-only Windows forced cleanup

The focused `antigravity-process-identity`, `runtime-observer`, `runtime-context` and
`windows-client-executable` unit suites cover engine role arguments, captured-path bypasses,
same-installation stale-path recovery, competing installations and Windows discovery layouts.
`windows-switch-close` covers normal acceptance, refused prompts, windowless processes,
reparented children, reused identities, failed or expired probes, conflicts, denied force and WSL identity.
It also covers transient descendant metadata before normal close and after reparenting, and
rejects persistent unreadability without treating a captured process as exited.
An updater appearing below the client during normal close aborts before any forced termination.
The observer suite includes PID 0 and creation-time parsing from a complete WSL CIM snapshot.
`runtime-preflight` runs the production preflight and observer together. It covers a partial
Windows process snapshot that becomes readable after the status-query deadline, the shared
five-second updater/client budget, and persistent unreadability remaining a failure.
`runtime-stop` retains ordinary stop's refusal policy; `runtime-switch` selects the forced policy.

`node scripts/test-antigravity-launch.integration.mjs` uses isolated temporary binaries and the
production observer/stop functions. Windows checks ordinary windowless refusal followed by
switch-only forced cleanup, verifies all nine fixture processes are gone, and checks there is
exactly one launch per cycle. Its optional WSL mode uses the Windows CIM bridge. No installed
client, shared credential or provider request is involved. This check proves process cleanup,
not saving unsaved buffers or an official-client account change. Forced cleanup can discard work.

### Existing supervised IDE coverage

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

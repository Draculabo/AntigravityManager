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

`npm run check:governance` analyzes the current worktree, including untracked source files and unstaged deletions, and enforces every runtime boundary rule. It is not a report-only check.

## Native process queries

The published `@draculabo/sysinfo-process-enhanced` dependency provides read-only process
queries. After `npm ci`, run `node scripts/test-sysinfo.integration.mjs`.
Run the same script under Electron with `ELECTRON_RUN_AS_NODE=1` to verify native loading
and real process metadata. The check uses a dedicated temporary child with spaces,
Unicode, quotes, empty argv and trailing backslashes; it does not target installed apps.
The existing Antigravity launch integration script verifies the production observer on
native Windows, Linux and optionally WSL Windows interop.

After changing native dependency or packaging configuration, run `npm run package`.
Verify the main package remains inside `app.asar`, its matching platform binary exists
under `app.asar.unpacked/node_modules/@draculabo`, and the packaged loader can query a
real process under Electron. The existing AutoUnpackNatives plugin unpacks `.node` files.

## Type and React quality gates

`npm run verify:type-boundaries` blocks new production `any`, double assertions, native `fetch`, direct JSON assertions and `@ts-ignore` entries against `.agents/type-boundary-baseline.json`. Test, mock and generated sources are excluded. A controlled third-party adapter exception must be local, time-bounded and name its owner, tracking issue and reason.

React Doctor runs in pull requests with changed-line scope and error blocking. Telemetry, score sharing and supply-chain analysis are disabled. A full scan is advisory and establishes the existing-work baseline. React Scan is injected only for an explicitly enabled development Electron session; it is not bundled or run in CI.

## Focused commands

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
& .\node_modules\electron\dist\electron.exe scripts\traffic-audit-native.test.mjs
```

This checks real worker messages, database reopen, body paging, retention and physical disk
reclamation. It supplements, but does not replace, live gateway/provider acceptance.

Run static checks when a shared type, import surface, public export or cross-module contract changes:

```powershell
npm run type-check
npm run lint
npm run format
```

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

These fixtures do not write live OS credentials or prove official-client account identity. Release acceptance still requires two authorized test accounts, real IDE restart switching, Classic restart switching, CLI identity checks and a real AI request after each switch. IDE restart switching must confirm full shutdown and one restart. Confirm that a closed window is not reopened and a failed local confirmation is not reported as successful. Physical macOS and system-wide Linux desktop acceptance require separate runs.

# Testing Strategy

Select evidence according to the behavior a change can affect. Focused tests are the normal local default; exhaustive suites and platform matrices belong in CI or an explicitly requested full rehearsal.

## Checks for a contribution

Start with the [contribution workflow](../CONTRIBUTING.md) and select the row matching the
changed behavior in the [change-to-evidence matrix](#change-to-evidence-matrix). Run the owning
test first; add broader checks for affected consumers, public contracts or runtime boundaries.

For documentation-only changes, run the contract check and format check against the actual
changed paths, for example:

```powershell
pnpm run check:agent-contracts
pnpm exec prettier --check CONTRIBUTING.md docs/development.md
```

Replace the example paths with the changed documentation and template files. The repository
ignores `.agents/` and files named `README.md` in Prettier; checking those explicitly named files
requires an empty temporary `--ignore-path`. Do not run the repository-wide formatter across
unrelated untracked trees.

For a code change, run one owning Vitest file with `pnpm test <test-file>` and use the matrix
for additional evidence. Live-account, packaging and platform acceptance are separate procedures;
ordinary local checks do not require provider credentials. Git hooks check only their documented
baseline and do not establish a passing behavior suite.

Report the command, result, platform and checks not run. A failure or unavailable prerequisite
is not a pass; explain the gap rather than suppressing it or narrowing away a known failure.

## Evidence principles

Before selecting a repository runner, use [the script guide](../scripts/README.md) and [script instructions](../scripts/AGENTS.md) to identify its existing entry, prerequisites and effects. [Test reliability](test-reliability.md) owns resource isolation, asynchronous completion and intermittent-failure diagnosis. [Failure ownership](error-handling.md) defines which state and recovery outcomes failure-path checks must establish.

- A passing command is evidence only for paths it executes.
- Prefer user-visible output, persisted state, protocol output or another stable observable over private call sequences.
- New validation scripts and regression tests must be capable of failing for a representative violation.
- Never weaken assertions, skip checks or narrow coverage solely to make a failure disappear.
- Report only checks that actually ran; report blocked or unavailable evidence separately.

## Change-to-evidence matrix

Upgrade instructions and Agent Note replacement/archive metadata are checked by
`pnpm run check:agent-contracts`. These fixtures validate document structure and relationships;
they do not establish migration or recovery correctness. Underlying data changes still require
the persistence, backup and native evidence selected below. Archive-body preservation and the
decision to require a guide remain semantic review responsibilities.

The [Tests workflow](../.github/workflows/testing.yaml) runs the pinned Node 24 on Ubuntu and Windows,
including governance, installed Git hook integration, type checking, the complete Vitest unit
suite and acceptance harness unit tests. Local Git hooks run only their documented baseline;
they do not establish a passing unit suite or CI result.
The test, lint and formatting jobs select lanes from the [shared check inventory](../scripts/README.md#quality-checks).
`pnpm run check:quality` rejects missing lane invocations, suppressed failures and platform loss;
`pnpm run test:quality` checks these denials through synthetic workflows and the real runner.
Vitest caps workers at four to bound concurrent module loading across development and CI hosts;
the existing test and hook timeouts remain unchanged.

For a reported CI test failure, record the failing revision and job, reproduce its selected tests,
then run the complete unit suite on the affected OS after the fix. A focused pass does not clear
known failures in other files. Windows policy tests explicitly select the Windows branch while
keeping actual fixture paths valid on the host; mocked discovery must not depend on an installed
client. Native socket fixtures own their parent directories and clean up listeners before removal.

| Changed surface                            | Minimum local evidence                                                 | Add when applicable                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Pure utility, mapper or codec              | Owning Vitest file                                                     | Adjacent tests for a shared type or caller contract                                                     |
| Shared types, public exports or boundaries | `pnpm run type-check` and owning tests                                 | `pnpm run check:governance` when dependency direction or boundary rules change                          |
| React component or hook                    | Owning Testing Library/Vitest file                                     | Focused E2E for navigation, preload or multi-window behavior                                            |
| Route definition                           | Related component test and `pnpm run type-check`                       | Focused Playwright flow for user navigation changes                                                     |
| Cross-module or process-spanning user flow | Owning integration tests for each changed layer                        | Focused Playwright/Electron acceptance when navigation, preload, lifecycle or packaging changes         |
| ORPC schema or handler                     | Owning handler/router test and `pnpm run type-check`                   | Renderer consumer test when the result or error contract changes                                        |
| Preload bridge                             | `preload-sandbox.test.ts`, affected IPC test and `pnpm run type-check` | Focused Electron E2E when exposure or lifecycle changes                                                 |
| Electron main lifecycle                    | Owning startup, window, tray or process tests                          | Focused E2E; package when bundled runtime behavior changes                                              |
| SQLite repository or codec                 | Owning database/persistence tests                                      | Backup, restore, migration or durability tests for format changes                                       |
| Credential or security behavior            | Credential-store and sensitive-data tests                              | Native keyring or platform acceptance when storage providers change; mocks do not prove native behavior |
| Proxy request/response mapper              | Owning protocol mapper and streaming tests                             | Real-path parity or controller integration tests                                                        |
| Gateway controller/service                 | Owning integration and endpoint-coverage tests                         | E2E or live-provider evidence only when the external provider path changes                              |
| Packaging, updater or native artifact      | Owning packaging/update tests                                          | Installer, updater or platform acceptance when the shipped artifact path changes                        |
| Documentation or agent governance          | `pnpm run check:agent-contracts` and focused Prettier                  | `pnpm run check:governance` when governance rules or runtime boundaries change                          |
| Cross-platform or repository-wide behavior | Focused tests for each affected surface                                | CI platform matrix or explicitly requested full rehearsal                                               |

`pnpm run check:governance` analyzes the current worktree, including untracked source files and unstaged deletions, and enforces every runtime boundary rule. It is not a report-only check.

## Type and React quality gates

ESLint imports both `.gitignore` and `.prettierignore`. Generated Playwright output, packaged
test fixtures and other ignored build products stay outside source linting, while production
code and test sources remain in scope. This prevents saved minified bundles from consuming
the lint process's heap during `pnpm run check:static`.

`pnpm run verify:type-boundaries` blocks new production `any`, double assertions, native `fetch`, direct JSON assertions and `@ts-ignore` entries against `.agents/type-boundary-baseline.json`. Test, mock and generated sources are excluded. A controlled third-party adapter exception must be local, time-bounded and name its owner, tracking issue and reason.

React Doctor runs in pull requests with changed-line scope and error blocking. Telemetry, score sharing and supply-chain analysis are disabled. A full scan is advisory and establishes the existing-work baseline. React Scan is injected only for an explicitly enabled development Electron session; it is not bundled or run in CI.

## Focused commands

Build and acceptance scripts are organized by responsibility; see the
[script reference](../scripts/README.md) for directory ownership and prerequisites.
Run `pnpm run test:acceptance unit` for the pure Node harness tests. It exercises local fixtures and
protocol/report logic without live accounts, provider requests, application windows or installers.
`check:ci` and `test:all` include this check. Native, installed and live acceptance remain separate
explicit commands because they require matching native binaries, platform artifacts or prepared accounts.

Run a specific Vitest file:

```powershell
pnpm test src/tests/unit/<behavior>.test.ts
```

Run tests matching a name:

```powershell
pnpm test -t "<behavior>"
```

Run a focused Playwright file:

```powershell
pnpm run test:e2e src/tests/e2e/<flow>.spec.ts
```

Run static checks when a shared type, import surface, public export or cross-module contract changes:

```powershell
pnpm run type-check
pnpm run lint
pnpm run format
```

The formatting command above scans the complete workspace. For a focused change, use explicitly named paths as described in [contributor checks](#checks-for-a-contribution).

## Persistence and security coverage

Changes to SQLite, keyring adapters, credential migration, backups or serialized payloads require the owning focused tests and a failure-path test for corrupt, unavailable or unsupported stored data when that boundary can occur at runtime.

Do not add hostile-input tests to same-process values that TypeScript fully constrains. Do add them at JSON, IPC, file, database, process and external API boundaries.

## Full rehearsal

Use the full local approximation when the user requests it, when diagnosing CI, or when a change is genuinely repository-wide:

```powershell
pnpm run check:ci
pnpm run test:e2e
```

Packaging and distributable generation are separate evidence. Run `pnpm run package` or `pnpm run make` only when build configuration, native dependencies, packaged paths, update behavior or artifacts can be affected.

## Environment-dependent evidence

Some Electron, OS keyring, native-module, live-provider, update and packaging paths depend on platform capabilities or credentials. Record the exact skipped evidence and why. A focused test passing with mocked Electron or keyring modules does not prove the corresponding native integration.

## Topic guides

Select the owner after choosing evidence in the matrix. These guides preserve the scenario
prerequisites, failure checks, cleanup and limits of what each result establishes.

| Changed behavior                                                | Detailed evidence                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Core ownership, native workers, shutdown and private capture    | [Native runtime acceptance](testing/native-runtime.md)                                           |
| Account conversion, deletion and SQLite reopen                  | [Cloud-account persistence checks](modules/cloud-account/overview.md#focused-persistence-checks) |
| Gateway protocols, signatures and coding-tool configuration     | [Gateway testing](modules/proxy-gateway/testing.md)                                              |
| Client processes, credential destinations and account switching | [Client runtime testing](modules/antigravity-runtime/testing.md)                                 |
| Renderer, notification and preload behavior                     | [Desktop testing](modules/app-shell/testing.md)                                                  |
| SDK reporting and account-operation diagnostics                 | [Diagnostic acceptance](testing/diagnostics.md)                                                  |
| Packaged runtime, installation and updates                      | [Delivery acceptance](testing/delivery.md)                                                       |

Existing section links remain navigation entries for the moved topics below.

| Topic                                                                                                                 | Current owner                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| <a id="account-operation-diagnostic-acceptance"></a>Account-operation diagnostic acceptance                           | [Guide](testing/diagnostics.md#account-operation-diagnostic-acceptance)                    |
| <a id="native-process-queries"></a>Native process queries                                                             | [Guide](modules/antigravity-runtime/testing.md#native-process-queries)                     |
| <a id="desktop-workspace-checks"></a>Desktop workspace checks                                                         | [Guide](modules/app-shell/testing.md#desktop-workspace-checks)                             |
| <a id="renderer-update-profiling"></a>Renderer update profiling                                                       | [Guide](modules/app-shell/testing.md#renderer-update-profiling)                            |
| <a id="preload-traffic-events-under-content-security-policy"></a>Preload traffic events under Content Security Policy | [Guide](modules/app-shell/testing.md#preload-traffic-events-under-content-security-policy) |
| <a id="standalone-delivery-acceptance"></a>Standalone delivery acceptance                                             | [Guide](testing/delivery.md#standalone-delivery-acceptance)                                |
| <a id="proxy-gateway-coverage"></a>Proxy-gateway coverage                                                             | [Guide](modules/proxy-gateway/testing.md#proxy-gateway-coverage)                           |
| <a id="client-credential-storage-checks"></a>Client credential storage checks                                         | [Guide](modules/antigravity-runtime/testing.md#client-credential-storage-checks)           |
| <a id="ide-hot-switch-lifecycle-checks"></a>IDE hot-switch lifecycle checks                                           | [Guide](modules/antigravity-runtime/testing.md#ide-hot-switch-lifecycle-checks)            |
| <a id="classic-terms-retention"></a>Classic terms retention                                                           | [Guide](modules/antigravity-runtime/testing.md#classic-terms-retention)                    |

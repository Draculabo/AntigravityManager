# Repository scripts

This is a current reference for build and acceptance tooling. Application business logic lives in
`src/cli`, `src/core` and the owning `src/modules` feature. These scripts prepare artifacts or exercise
that implementation; they do not implement an additional application runtime.

Agents use this directory as the first place to locate runnable verification evidence. Read
[script instructions](AGENTS.md) before running or changing a runner. [Testing strategy](../docs/testing.md)
owns the change-to-evidence matrix; this guide identifies existing tools and their effects.

## Directory ownership

| Directory                 | Responsibility                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `build/`                  | Prepare the standalone runtime, trace its dependencies and create NSIS from the Forge package. |
| `acceptance/runtime/`     | Native SQLite, diagnostic workers, standalone startup and packaged desktop checks.             |
| `acceptance/installers/`  | MSI, Squirrel and NSIS installation/update checks and controlled upgrade fixtures.             |
| `acceptance/accounts/`    | Account switch readback, official-client sign-in and conversation preservation.                |
| `acceptance/agents/`      | One-click tool configuration, complete coding tasks, traffic monitor comparison and reports.   |
| `acceptance/multimodal/`  | Image/video input and image output checks.                                                     |
| `acceptance/thinking/`    | Reasoning signatures and multi-turn tool continuation across supported protocols.              |
| `acceptance/schema/`      | Schema replay, actual coding-client/provider checks and bounded diagnostic evidence.           |
| `acceptance/diagnostics/` | Node/Electron SDK reporting and packaged operation-diagnostic checks.                          |
| `acceptance/helpers/`     | Preparation or cleanup used by multiple acceptance runners.                                    |
| `acceptance/fixtures/`    | Fixed media inputs; runtime-specific fixture constants stay with their runtime suite.          |
| `development/`            | Development-server connection regression checks.                                               |
| `release/`                | Release-note generation, source metadata and controlled publication tests.                     |

Existing governance, performance and release utilities remain at the root. npm commands are defined
in [package.json](../package.json); use their names rather than relying on a script's filesystem path.
The scripts source directory is excluded from the application package. Build outputs are delivered
through the configured Forge resource and installer steps.

## Git hooks

`git/` owns the Lefthook adapter, guarded installation, staged-governance selector and preserved
pre-commit hook invocation. Use `npm run hooks:install` to install, `npm run hooks:pre-commit` or
`npm run hooks:pre-push` to check manually, and `npm run test:git-hooks` for isolated integration
evidence. [Local Git checks](../docs/development.md#local-git-checks) owns installation, automatic
checks, current-worktree limitations, CodeGraph coexistence and recovery.

## Unified acceptance entry

`npm run test:acceptance -- --help` lists the available suites. Choose a suite and check, followed by
the existing check arguments; the dispatcher forwards them unchanged and starts only that check.
For example:

```powershell
npm run test:acceptance -- unit
npm run test:acceptance -- runtime bootstrap --runtime-root C:\matching-node-runtime
npm run test:acceptance -- accounts prepare
npm run test:acceptance -- agents report /path/to/report.json
```

Use `npm run test:acceptance -- installers --help` to list installer checks, or another suite name
for its help. There is no automatic all-platform, live-account or installer sequence. The fixture
generator commands remain build commands because they create test artifacts rather than validate them.

## Choose the appropriate check

Select evidence by the affected behavior, then inspect the owning command or SOP before execution:

| Verification need                          | Existing entry                                                           | Prerequisites and effects                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent instructions, Skills and Agent Notes | `npm run check:agent-contracts`                                          | Checks governance fixtures, local links and named npm commands; does not exercise application behavior.                                                                    |
| Change scope                               | `npm run change-scope -- --base HEAD` for worktree changes               | Reads Git metadata. Outgoing/PR changes require the verified base and head rather than an assumed base.                                                                    |
| Pure acceptance harness behavior           | `npm run test:acceptance -- unit` or the owning `node --test` file       | Uses synthetic fixtures; see the coverage and exclusions below.                                                                                                            |
| Native core, preload or desktop behavior   | `npm run test:acceptance -- runtime <check>`                             | Select the check listed by top-level help; built artifacts, matching native ABI and isolated state depend on the check.                                                    |
| Real account switching or client history   | `npm run test:acceptance -- accounts <check>`                            | Follow the [account SOP](../docs/account-switch-acceptance.md); may close clients or change shared credentials and must verify restoration.                                |
| Real coding-client or provider behavior    | `agents`, `multimodal` or `thinking` acceptance suites                   | Follow the linked SOPs below; may consume quota or change isolated tool configuration.                                                                                     |
| Schema replay and live protocol diagnosis  | Existing `test:schema:*` npm commands                                    | Follow [live Schema acceptance](../docs/development.md#live-schema-acceptance); replay, live requests and remote reporting have different effects.                         |
| Diagnostic reporting                       | `npm run test:diagnostics:sentry` or `npm run test:diagnostics:packaged` | Follow [diagnostic acceptance](../docs/testing.md#account-operation-diagnostic-acceptance); default/local, packaged and live reporting modes establish different evidence. |
| Installer or updater behavior              | `npm run test:acceptance -- installers <check>`                          | Requires the matching artifact and owning [delivery procedure](../docs/testing.md#standalone-delivery-acceptance); may install or update software.                         |

Build commands, fixture generators, report aggregation and release tools are separate operations.
Creating an artifact or summarizing a report does not prove the behavior of the resulting product.
The table is a discovery aid, not an instruction to run every suite. Public CLI help and `package.json`
own the available commands; the owning SOP specifies exact arguments and environment requirements.

`npm run test:acceptance -- unit` runs the local Node test suites for dependency tracing, update feed
selection, authentication-state interpretation, tool configuration, audit pagination, report verdicts,
media validation, protocol continuation and native-fixture isolation. It needs installed project
dependencies, but does not sign in to providers, send model requests, open an application window,
install software or load SQLite native binaries. `check:ci` and `test:all` include this command;
the default Vitest `npm test` command remains scoped to application unit tests.

Native acceptance needs built entries and dependencies matching the executing Node or Electron ABI.
`npm run test:acceptance -- runtime diagnostics --smoke` checks just the built standalone workers.
The same command without `--smoke` checks service operations and terminal lifecycle.
Both Node service runners accept `--runtime-root <directory>` for their complete checks, allowing
the fixture to use a separately prepared native dependency tree without rebuilding desktop dependencies.
See [the testing strategy](../docs/testing.md) for runtime prerequisites and matching-ABI commands.

The `runtime preload-csp` check builds the production preload and exercises its traffic callbacks
inside an isolated real Electron window, without accounts or upstream requests. See the
[CSP acceptance procedure](../docs/testing.md#preload-traffic-events-under-content-security-policy)
for the policy timing variants and regression mode.

Live account, model and installer suites have separate explicit commands. They require prepared
isolated profiles, platform artifacts and, for model tasks, an authorized account with sufficient
quota. A pure harness test does not prove that an installed client or upstream model works.
Follow the [account SOP](../docs/account-switch-acceptance.md),
[coding-tool SOP](../docs/live-agent-acceptance.md) or
[media and thinking SOP](../docs/live-proxy-media-thinking-acceptance.md) as appropriate.

The report command also supports `--refresh PROFILE_HOME REPORT...`. It rebuilds the model request
window from the still-running local acceptance gateway, writes separate `report.reconciled.json`
files and summarizes the refreshed reports. The original reports are preserved.

## Record acceptance evidence

Record the command, revision and tested artifact/runtime, platform, selected scenario, expected observable
and actual result. Include cleanup/restoration results and a sanitized report path when the runner emits one.
Separate preparation, synthetic checks, native checks and live-provider evidence in the result. A process
exit code alone cannot establish real account identity, persisted consent or successful recovery.

When no existing runner covers the behavior, add the smallest owned scenario using the
[script instructions](AGENTS.md) and [reliability rules](../docs/test-reliability.md). Preserve a representative
failing case so a changed acceptance rule can demonstrate rejection as well as success.

## File conventions

- `*-entry.ts` and desktop fixture entries bundle real production modules for a particular test runtime.
- `*.test.mjs` contains Node test assertions. Only the explicitly selected pure suites belong in
  `test:acceptance -- unit`; the native audit suite needs Electron's matching SQLite binary.
- Installer fixture generators create disposable previous-version packages for upgrade checks.
- The audit native entry imports separate persistence, thought-store and retention suites. The shared
  worker fixture owns their temporary databases and cleanup.

Keep setup shared only when multiple current runners use the same contract. Preserve scenario-specific
assertions, bounded subprocess output, timeouts, profile isolation and verified cleanup targets.

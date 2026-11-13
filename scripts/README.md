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
| `release/`                | Release-note generation, source/asset metadata and controlled publication tests.               |
| `github/`                 | Issue policy, official-SDK inference, validated write-back and workflow contracts.             |
| `review-eval/`            | Manually prepared historical source audits, evaluator rubrics and adjudicated reports.         |
| `agent-skills/`           | Read-only skill inventory, provenance policy and entry mirror contracts.                       |
| `agent-routing/`          | Manually evaluated workflow-selection cases and their structural contracts.                    |

Existing governance, performance and release utilities remain at the root. pnpm commands are defined
in [package.json](../package.json); use their names rather than relying on a script's filesystem path.
The scripts source directory is excluded from the application package. Build outputs are delivered
through the configured Forge resource and installer steps.

## Git hooks

`git/` owns the Lefthook adapter, guarded installation, staged-governance selector and preserved
pre-commit hook invocation. Use `pnpm run hooks:install` to install, `pnpm run hooks:pre-commit` or
`pnpm run hooks:pre-push` to check manually, and `pnpm run test:git-hooks` for isolated integration
evidence. [Local Git checks](../docs/development/git-checks.md#local-git-checks) owns installation, automatic
checks, current-worktree limitations, CodeGraph coexistence and recovery.

The commit hook lints staged JavaScript and TypeScript blobs with the current worktree ESLint
configuration. It leaves the index and unstaged edits intact. Governance changes also check the
shared CI wiring. These checks do not establish a passing application test suite.

## Quality checks

`pnpm run skills:inventory` reports managed skill entries, provenance and advisories without
modification. `check:agent-contracts` includes the skill and route-fixture contracts and their
negative tests. See [skill maintenance](../docs/development/agent-skills.md) for update ownership
and [routing evaluation](../docs/testing/agent-routing.md) for independent model evidence.

`pnpm run check:agent-contracts` also validates upgrade guide structure and explicit Agent Note
replacement/archive metadata. Its fixtures cover missing recovery instructions, invalid versions,
one-way links, archive dates and replacement cycles. Current links remain checked; frozen archive
body examples are historical. The [upgrade guide rules](../docs/upgrade-guides/README.md) and
[note retention rules](../.agents/notes/README.md#supersession-and-retention) own human review.

`quality/checks.mjs` owns the check inventory, purpose descriptions, local groups and CI lanes.
Use `pnpm run check:ci --list` to discover the current commands without running them; add a lane
before `--list` to inspect just that selection. `pnpm run check:ci` executes the complete registered
selection, which includes repository-wide tests and formatting and may be expensive. Focused pnpm
commands remain available for ordinary development.

`pnpm run check:quality` verifies the registry against package scripts and the actual workflow jobs.
Each registered check needs a nonempty purpose and a CI lane. The required jobs execute their lane
unconditionally, propagate failure and retain the declared platforms. Local governance/static
commands select entries from the same inventory. `pnpm run test:quality` exercises the real runner
with synthetic commands and deliberately invalid workflow fixtures.

Every pnpm verification command named `test`, `test:*`, `check:*` or `verify:*` is classified as a CI
leaf, a shared aggregate or an explained additional entry point. New unclassified commands fail
the contracts. The full `--list` output also describes aliases, nested checks and manually selected
acceptance commands. Additional entries are excluded from the automatic selection; live and native
checks retain their owning prerequisites and authorization.

The runner executes checks sequentially, stops after a failure and reports remaining checks as
`not-run`. It prints duration and exit information; an aborted or failed child cannot count as a
pass. CI keeps test, lint and formatting lanes in separate jobs. Registry checks do not attest to
GitHub scheduling, package installation, native integrations or live providers. New checks update
the registry description and their owning procedure; the executable inventory avoids duplicating
the command list here. Acceptance scripts remain owned by the dispatcher below.

[GitHub automation](../docs/development/github-automation.md) owns the reusable build lane,
conservative docs/full PR selection, complete merge gate and optional issue triage. The runner
defaults to full checks outside positively identified documentation-only PRs. `test:automation`
uses synthetic SDK responses and GitHub fixtures; `check:automation` validates actual workflow
permissions and gate wiring. Neither command calls a provider or mutates GitHub. Inference is
invoked only by the opt-in workflow; it consumes API tokens, writes temporary result files and
uses the documented external-data policy. Local Git hooks are installed normally after dependency
installation; CI-only dependency setup skips lifecycle scripts in credentialed triage jobs.

## Unified acceptance entry

Release artifact verification uses `pnpm run test:acceptance release artifacts --source <directory>`.
Release publication recovery fixtures use `pnpm run test:acceptance release delivery`.

Native installer logging uses `pnpm run test:acceptance installers nsis-feedback <makensis.exe>`.
The [installer verification procedure](../docs/testing/delivery.md) describes its Windows compiler
prerequisite, isolated output, assertions and limits. It does not install the application.

The NSIS artifact inventory uses `pnpm run test:acceptance installers nsis-inventory <packaged-app>
<installer.exe> <report.json>`. All paths must be under `out/`, and the report path must be new and
outside the inspected application directory. It records installer size and SHA-256, payload file
counts and sizes, ASAR entry count, and byte-identical files. It does not extract or install the
installer.
It reads merged build outputs and optionally GitHub artifact inventory pages, without GitHub writes
or installer execution. The [release workflow procedure](../docs/development/build-and-package.md#release-workflow-verification)
owns prerequisites, inventory capture, dry-run behavior and evidence limits. Its synthetic negative
fixtures run through the existing `unit` selection.

Historical reviewer evaluation uses `pnpm run review:eval prepare` and `pnpm run review:eval score`.
Follow the [evaluation procedure](../docs/testing/review-evaluation.md) for local-history prerequisites,
source isolation, human adjudication and evidence limits. Preparation writes a new directory outside
the repository; scoring is read-only. Neither command invokes a model or a provider.
`pnpm run test:review-eval` exercises the harness and historical probes and is manually selected.

`pnpm run test:acceptance --help` lists the available suites. Choose a suite and check, followed by
the existing check arguments; the dispatcher forwards them unchanged and starts only that check.
For example:

```powershell
pnpm run test:acceptance unit
pnpm run test:acceptance runtime bootstrap --runtime-root C:\matching-node-runtime
pnpm run test:acceptance accounts prepare
pnpm run test:acceptance agents report /path/to/report.json
```

`scripts/release/build-source-manifest.mjs` is used by the publish workflow to record the exact
source SHA, package version, platform, architecture and checksums for each matrix build. Build,
verification and publication use the workflow's triggering commit. Directory validation checks
one manifest per build target and matches their source and version to the checkout:

```powershell
node scripts/release/build-source-manifest.mjs --root . --validate-directory release-assets
```

Before creating a draft or uploading assets, the publish job fetches the selected tag from the
repository and also passes `--release-tag <tag>`. The tag must already exist and match both the
package version and the checked-out commit. For manual publication, run the workflow from the
tagged revision. A dry run can validate a revision before its tag exists.

The minimal Core/CLI container consumes the matching prepared Linux runtime and
keeps its profile in `/var/lib/antigravity-manager`. It does not package
Electron or the web UI:

```bash
pnpm run prepare:standalone
docker build --build-arg RUNTIME_ARCH=x64 -f docker/standalone-core/Dockerfile .
```

The container entrypoint uses the existing CLI management endpoint for health
and sends `service stop` before waiting for Core to drain on `SIGTERM`. Docker
builds, native system-library availability and live gateway behavior require
the Docker/target platform and are separate acceptance evidence.

Use `pnpm run test:acceptance installers --help` to list installer checks, or another suite name
for its help. There is no automatic all-platform, live-account or installer sequence. The fixture
generator commands remain build commands because they create test artifacts rather than validate them.

## Choose the appropriate check

Select evidence by the affected behavior, then inspect the owning command or SOP before execution:

| Verification need                          | Existing entry                                                             | Prerequisites and effects                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent instructions, Skills and Agent Notes | `pnpm run check:agent-contracts`                                           | Checks governance fixtures, local links and named pnpm commands; does not exercise application behavior.                                                                               |
| Change scope                               | `pnpm run change-scope --base HEAD` for worktree changes                   | Reads Git metadata. Outgoing/PR changes require the verified base and head rather than an assumed base.                                                                                |
| Pure acceptance harness behavior           | `pnpm run test:acceptance unit` or the owning `node --test` file           | Uses synthetic fixtures; see the coverage and exclusions below.                                                                                                                        |
| Native core, preload or desktop behavior   | `pnpm run test:acceptance runtime <check>`                                 | Select the check listed by top-level help; built artifacts, matching native ABI and isolated state depend on the check.                                                                |
| Real account switching or client history   | `pnpm run test:acceptance accounts <check>`                                | Follow the [account SOP](../docs/modules/antigravity-runtime/account-switch-acceptance.md); may close clients or change shared credentials and must verify restoration.                |
| Real coding-client or provider behavior    | `agents`, `multimodal` or `thinking` acceptance suites                     | Follow the linked SOPs below; may consume quota or change isolated tool configuration.                                                                                                 |
| Schema replay and live protocol diagnosis  | Existing `test:schema:*` pnpm commands                                     | Follow [live Schema acceptance](../docs/modules/proxy-gateway/schema-conversion.md#live-schema-acceptance); replay, live requests and remote reporting have different effects.         |
| Diagnostic reporting                       | `pnpm run test:diagnostics:sentry` or `pnpm run test:diagnostics:packaged` | Follow [diagnostic acceptance](../docs/testing/diagnostics.md#account-operation-diagnostic-acceptance); default/local, packaged and live reporting modes establish different evidence. |
| Installer or updater behavior              | `pnpm run test:acceptance installers <check>`                              | Requires the matching artifact and owning [delivery procedure](../docs/testing/delivery.md#standalone-delivery-acceptance); may install or update software.                            |

Build commands, fixture generators, report aggregation and release tools are separate operations.
Creating an artifact or summarizing a report does not prove the behavior of the resulting product.
The table is a discovery aid, not an instruction to run every suite. Public CLI help and `package.json`
own the available commands; the owning SOP specifies exact arguments and environment requirements.

`pnpm run test:acceptance unit` runs the local Node test suites for dependency tracing, update feed
selection, authentication-state interpretation, tool configuration, audit pagination, report verdicts,
media validation, protocol continuation and native-fixture isolation. It needs installed project
dependencies, but does not sign in to providers, send model requests, open an application window,
install software or load SQLite native binaries. `check:ci` and `test:all` include this command;
the default Vitest `pnpm test` command remains scoped to application unit tests.

Native acceptance needs built entries and dependencies matching the executing Node or Electron ABI.
`pnpm run test:acceptance runtime diagnostics --smoke` checks just the built standalone workers.
The same command without `--smoke` checks service operations and terminal lifecycle.
Both Node service runners accept `--runtime-root <directory>` for their complete checks, allowing
the fixture to use a separately prepared native dependency tree without rebuilding desktop dependencies.
See [the testing strategy](../docs/testing.md) for runtime prerequisites and matching-ABI commands.

The `runtime preload-csp` check builds the production preload and exercises its traffic callbacks
inside an isolated real Electron window, without accounts or upstream requests. See the
[CSP acceptance procedure](../docs/modules/app-shell/testing.md#preload-traffic-events-under-content-security-policy)
for the policy timing variants and regression mode.

Live account, model and installer suites have separate explicit commands. They require prepared
isolated profiles, platform artifacts and, for model tasks, an authorized account with sufficient
quota. A pure harness test does not prove that an installed client or upstream model works.
Follow the [account SOP](../docs/modules/antigravity-runtime/account-switch-acceptance.md),
[coding-tool SOP](../docs/modules/proxy-gateway/acceptance/live-agent.md) or
[media and thinking SOP](../docs/modules/proxy-gateway/acceptance/media-thinking.md) as appropriate.

The report command also supports `--refresh PROFILE_HOME REPORT...`. It rebuilds the model request
window from the still-running local acceptance gateway, writes separate `report.reconciled.json`
files and summarizes the refreshed reports. The original reports are preserved.

## Record acceptance evidence

The focused native launch fixture, `node scripts/test-antigravity-launch.integration.mjs`,
verifies process discovery and startup using a unique temporary installation. On Windows it
checks ordinary windowless close refusal and account-switch forced tree cleanup in three cycles.
`--wsl-interop` selects its Windows fixture through the existing WSL bridge. It never writes
credentials or starts an installed client; cleanup is restricted to its temporary fixture.
See [runtime evidence limits](../docs/modules/antigravity-runtime/testing.md#discovery-and-switch-only-windows-forced-cleanup).

`node scripts/acceptance/accounts/test-windows-graceful-close.integration.mjs` runs disposable
WinForms windows on Windows. It checks visible/hidden normal-close buffer flushing, ordinary
stop refusal and switch-only forced exit after a cancelled close. It never starts an installed
client or writes credentials; forced exit does not establish that unsaved data was saved.

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
  - The `runtime/thought-store-native.test.mjs` leaf accepts `AGM_THOUGHT_WORKER_ENTRY`
    pointing to the rebuilt `dist/core/thought-store.worker.js`; every scenario uses
    the selected artifact. It checks bounded decode/metadata/count reads, exact
    control-character readback, preserved corrupt rows, cold suffixes and reopen.
    Management cases add bounded metadata pages beyond 10,000 rows, a stable
    high-water traversal, exact session/record receipts and failed-delete rollback.
    It needs the matching Electron SQLite ABI and uses only fixture-owned databases.
  - The `runtime/thought-retention-native.test.mjs` leaf uses the same optional
    `AGM_THOUGHT_WORKER_ENTRY` after `build:core`. It checks bounded record deletion,
    pinned-reader pause/resume, repeated no-progress stopping and recent-session
    protection. The combined native entry imports it; its temporary databases and
    Worker connections are owned by the shared fixture.
  - The persistence leaf's exact-session scenario accepts `AGM_AUDIT_WORKER_ENTRY`
    after `build:core`; it checks full saved-key equality, paging/count and exclusion
    of sessionless admin events in disposable databases. Other persistence scenarios
    retain their Forge artifact selection. See [native runtime acceptance](../docs/testing/native-runtime.md).
    Its session-snapshot scenario also selects that Worker and checks active-record
    refusal, fingerprint/change/deletion handling and bounded session admission.
  - Audit admission scenarios also run through that native entry. After `build:core`, the
    individual `runtime/audit-admission-native.test.mjs`, `runtime/audit-retention-native.test.mjs`, `runtime/audit-recovery-native.test.mjs` and `runtime/audit-clear-native.test.mjs` accept `AGM_AUDIT_WORKER_ENTRY`
    pointing to the built production audit worker. It uses disposable databases and checks
    budget rejection, continued reads and reopen. Retention checks cover age-independent
    capacity windows, whole-parent cascades, active protection, 70% reclamation and
    concurrent clear/delete. Recovery checks cover process-boundary reconciliation,
    live Worker replacement, retained prefixes and separate archive accounting without
    deletion. Clear checks cover class-scoped deletion, stale queued parent/admin rejection,
    missing-owner payload/attempt writes and atomic rollback after an injected deletion
    failure. Use the worker's matching native ABI; all fixtures are disposable.

Keep setup shared only when multiple current runners use the same contract. Preserve scenario-specific
assertions, bounded subprocess output, timeouts, profile isolation and verified cleanup targets.

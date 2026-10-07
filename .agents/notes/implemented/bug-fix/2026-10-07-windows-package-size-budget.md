# Agent Note: Windows package size budget

Status: implemented

## Problem

The Windows release audit still uses a 150 MiB installer budget established before the
standalone runtime was bundled. The reported release installers are 179.27 MiB (Squirrel EXE),
179.38 MiB (NuGet) and 182.75 MiB (WiX MSI), while their 107.67 MiB ASAR passes its existing budget.
In the local NuGet artifact, the independently executable Node runtime and its traced dependencies
occupy 38.59 MiB compressed and 109.27 MiB uncompressed. Removing that subtree would break
installed CLI and standalone service execution. The local ASAR also contains 34.78 MiB of
development files under `node_modules/.vite` that are not application resources.

## Decision

Allow 200 MiB for each installer, including Electron and the standalone runtime. Keep the
120 MiB ASAR budget and add a separate 120 MiB budget for the uncompressed standalone tree.
Exclude the dependency cache under `node_modules/.vite`, retaining the production bundles
under the root `.vite`. Select the expected package's resources directly instead of searching
acceptance profiles throughout `out`.

## Alternatives considered

- Keeping the previous total budget would reject the required runtime payload even when both
  application resources remain within their individual budgets.
- Removing bundled Node or reusing Electron's native binaries would invalidate the independent
  CLI runtime and its tested ABI separation.
- Removing the audit or allowing unlimited resource growth would lose the release regression gate.

## Consequences

Installers have explicit headroom for the current delivery architecture. Independent ASAR and
standalone checks still reject accidental resource growth, missing resources and a return to
untraced dependency delivery. Existing environment overrides remain available; standalone adds
`AGM_MAX_WIN32_X64_STANDALONE_MB`. Installer formats, runtime versions and update behavior do
not change. Future runtime upgrades must reassess these budgets using actual package composition.

## Verification

Focused size and ignore-policy tests check representative installer sizes, per-resource budgets,
over-budget failures, missing resources, unrelated acceptance profiles and Windows cache paths.
The regenerated ASAR is 111.30 MiB, excludes `node_modules/.vite` and retains the production
main bundle. Actual packaged Electron ABI 136 and standalone Node ABI 137 each load all five
native modules and pass an in-memory SQLite query; the standalone manifest's six hashes match.
On 2026-10-07, fresh application packaging produces these verified resources. Installer generation
with `npm run make -- --skip-package` against that fresh package exits zero, as does
`npm run audit:size:win32:x64`: EXE 180.39 MiB, NuGet 180.49 MiB, MSI 183.90 MiB,
ASAR 111.30 MiB and standalone 109.27 MiB. All 11 focused tests and TypeScript checking pass.
This evidence does not cover installing or upgrading an application. Repository-wide formatting
still reports 17 existing files, and agent-contract checking reports the existing indentation
defect in the proxy-account-continuity note; the changed files pass their focused checks.

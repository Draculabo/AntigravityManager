# Agent Note: pnpm and Node 24 toolchain

Status: implemented

## Problem

Development and CI used Node 22 with npm, while packaged standalone resources used Node 24.19.0.
Changing only contributor commands would leave native rebuilds, release preparation and Git gates
on incompatible installation paths.

## Decision

Pin Node 24.22.0 in .nvmrc and read that version for standalone downloads and CI. Pin pnpm
10.34.6 through packageManager and keep pnpm-lock.yaml as the sole dependency lock. The maintained
pnpm 10 line retains the JavaScript CLI contract used by Forge subprocesses. Keep the hoisted
layout required by existing native loaders and package tracing. Serialize tar packing jobs when
materializing the traced hardlinked files: the concurrent tar queue can otherwise remain
unsettled. A real hardlink fixture reproduces that failure before the change. Use a named dependency-build
allowlist and pnpm patchedDependencies for the existing Forge cleanup correction. A second
patch makes the Windows optional icon extractor error-message pointer const-correct for the
Node 24 compiler; it is retained only until that upstream source includes the correction.

Production preparation installs the same frozen lock into isolated staging, disables general
install scripts and explicitly rebuilds the existing native packages with the downloaded Node.
Release preparation updates the private package manifest without invoking npm or publishing a
registry package. Application data formats and release approval gates stay unchanged.

## Alternatives considered

- Changing only package commands leaves runtime preparation and CI using the old manager.
- An isolated symlink layout would require unrelated changes to native-loader and packaging contracts.
- pnpm 12's native CLI requires a separate change to the current Node-invoked package-manager contract.

## Consequences

Contributors activate the pinned Node and pnpm versions and install with a frozen lockfile.
Only explicitly listed dependency lifecycle scripts run. External coding clients' npm/npx
configuration and registry package identifiers keep their existing semantics. Historical
execution records retain their original version and command evidence.

Reverting this toolchain change restores the previous package manifest, npm lockfile, patch
mechanism and scripts together; rebuild dependencies before running the reverted checkout.
Application profiles do not require migration.

## Verification

- `pnpm install --frozen-lockfile` completed with Node 24.22.0 and pnpm 10.34.6 on Windows;
  the optional icon extractor compiled with its patch, and no dependency builds remained blocked.
- `pnpm run test:acceptance unit` passed all 70 harness tests, including the private release
  manifest test. Quality contracts and their negative fixtures, all 16 Git-hook harness tests,
  type checking and scoped lint/format checks passed.
- The hardlink materialization fixture failed before serializing tar jobs and passed afterward.
  `pnpm run prepare:standalone` then produced the Windows x64 runtime successfully.
- `pnpm run test:acceptance runtime installed dist/.runtime/win32-x64/standalone` passed with
  resources copied outside the checkout. It exercised SQLite reopen, native keyring operations,
  standalone startup, authenticated gateway behavior, shutdown and crash recovery.

Full-suite validation exposed an unfinished simulated old runner in the Batch restart test;
the test now drains that runner before removing its temporary directory.
An earlier `pnpm test --maxWorkers=2` run passed 434 of 435 files and 3309 tests, with four
skipped tests and one failure: the first renderer Vite configuration import exceeded its existing
15-second test deadline. The renderer-config and Batch files then passed together in isolation
(14 tests). Four independent renderer-config processes passed concurrently, and five related
files passed together with four workers (29 tests).

The final full run used the configured four workers without overlapping other checks:
`pnpm test --bail=1 --reporter=json --outputFile=.tmp/pnpm-node24-migration/unit-isolated.json`.
All 435 files and 3310 tests passed, with four skipped tests and exit status zero. The first
renderer-config test took 3.3 seconds; the remaining cases took 5–11 milliseconds each.
The earlier first-import timing failures were not reproduced consistently, and their original
cause remains unconfirmed. No Vite configuration, deadlines or assertions were changed to obtain
the passing result.
Native packaging on other platforms, desktop installers and GitHub workflow execution require
their matching runners; local Windows standalone evidence does not establish those environments.

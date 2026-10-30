# Agent Note: Release Action runtimes and artifact verification

Status: implemented

## Problem

Release builds used Actions declaring Node 20, a retiring macOS 14 image and a moving Ubuntu
label. The existing dry run skipped the entire publish job, leaving artifact download, merge
layout and feed preparation untested when upgrading transport Actions.

## Decision

Pin the maintained Node 24 Action releases to verified full commits, independently of the
project toolchain recorded in the [toolchain decision](2026-10-16-pnpm-node24-toolchain.md).
Use macOS 15 for arm64 and keep macOS 15 Intel for x64. Pin release-related Linux jobs to
Ubuntu 24.04 while ordinary PR lanes retain their existing platform coverage.

A read-only job verifies the current run's six build artifacts after all builds succeed,
including during dry runs. It downloads through the upgraded artifact Action, checks the
merged layout and prepares the Windows update feed locally. Publication depends on this job
and retains its existing event condition, release approval environment and update protection.
Both verification and publication use the same asset validator; validation precedes draft
release creation. The existing feed tool continues to own feed parsing and installer hashes.

## Alternatives considered

- Forcing old Actions onto Node 24 leaves unsupported runtime declarations in the workflows.
- Updating only the build Actions misses download and PR-creation Actions in publication.
- Building with dry-run enabled without a verification job does not exercise artifact downloads.
- Allowing dry runs into the publish job risks executing release writes and requires unnecessary
  release permissions or approval for artifact-only validation.
- Pinning every PR runner expands the change into the CI platform registry without improving
  reproducibility of release artifacts beyond the dedicated release jobs.

## Consequences

Verification adds one Linux job, dependency setup and an artifact download before publication.
Missing targets, empty required assets, expired artifacts and download digest mismatches block
publication. Synthetic fixtures establish validator sensitivity, not platform packaging or
remote Action execution. Native macOS compatibility, release uploads and automatic PR creation
remain separate acceptance evidence. The current procedure lives in the
[build guide](../../../../docs/development/build-and-package.md#release-workflow-verification).

Recovery changes only the failing workflow or Action reference to a supported, verified target.
The retiring macOS 14 image cannot be a continuing fallback. Dry runs leave no release writes;
real publication failures require inspecting existing release and PR effects before retrying.

## Verification

On Windows with Node 24.22.0 and pnpm 10.34.6, `pnpm run test:acceptance unit` passes all 88
tests, including 15 artifact checks and the existing Windows feed suite. The artifact fixtures
cover complete and paginated inventories, missing/duplicate/expired targets, missing platform
assets and the actual CLI's nonzero failure on incomplete downloads. The feed suite owns content
and installer-hash verification. The initial sandboxed harness run fails on restricted temporary
Git, symlink and hardlink operations; the permitted rerun passes without weakening assertions.

All 23 `pnpm run test:quality` tests pass. `pnpm run check:quality`,
`pnpm run check:automation`, scoped ESLint and formatting pass. Agent contract validation passes
its 28 fixtures and checks the current documents. These results establish local harness and
workflow-contract evidence only. Six-platform GitHub execution, native macOS behavior, actual
release uploads and automated PR creation remain unverified until the changed revision runs in
their corresponding environments.

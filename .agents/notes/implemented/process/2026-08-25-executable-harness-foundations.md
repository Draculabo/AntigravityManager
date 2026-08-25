# Agent Note: Executable harness foundations

Status: implemented

## Problem

The repository's agent governance described ownership and verification expectations, but it could not show the exact Git change set or detect a runtime import-path violation. The root IPC router also composed antigravity process handlers directly, making the documented feature-owned router boundary untrue in source.

## Decision

Add three read-only Node scripts backed by real Git and TypeScript APIs:

- `change-scope` emits a versioned report for committed, staged, unstaged and untracked paths without mutating the worktree.
- `analyze:imports` resolves Git-tracked TypeScript/JavaScript imports, exports, dynamic imports and `require` calls; runtime reachability ignores type-only edges.
- `verify:boundaries` consumes that graph to report renderer/preload and shared-direction violations. CI enforces its clean root-IPC subset and reports the remaining rules while known shared-to-feature dependencies remain.

Move app-shell and antigravity-runtime IPC composition into their owning modules. `src/ipc/router.ts` now applies global ORPC behavior and composes those exported router records, retaining the existing public RPC shape.

## Alternatives considered

- Enforce every detected boundary violation in CI now. Rejected because the existing shared-to-feature imports would turn a newly added gate into unrelated CI breakage.
- Keep a list of baseline violations and fail only on growth. Rejected because it normalizes debt and weakens the signal; reporting is explicit until an owner-approved migration removes the remaining violations.

## Consequences

- CI gains deterministic governance evidence before static and unit checks.
- Root ORPC composition has a CI-enforced feature-router-only import boundary.
- The current report continues to expose shared-to-feature violations rather than hiding them. A later migration must move or invert the affected target-selection contract, then enable `verify:boundaries:enforce` in CI.
- The scripts are intentionally read-only: no fetch, checkout, reset, index mutation or generated source output is permitted.

## Verification

- `node --test scripts/change-scope.test.mjs`
- `node --test scripts/import-graph.test.mjs`
- `node --test scripts/verify-runtime-boundaries.test.mjs`
- `node scripts/verify-runtime-boundaries.mjs --report`
- `node scripts/verify-runtime-boundaries.mjs --enforce-root-ipc`
- `npm run check:governance`

# Agent Note: Executable harness foundations

Status: implemented

## Problem

The repository's agent governance described ownership and verification expectations, but it could not show the exact Git change set or detect a runtime import-path violation. The first boundary gate also analyzed only paths recorded in the Git index, so an unstaged delete or untracked replacement made pre-commit verification fail before it could inspect the current code. Three reverse dependencies from `src/shared` to the account feature prevented full enforcement.

## Decision

Add three read-only Node scripts backed by real Git and TypeScript APIs:

- `change-scope` emits a versioned report for committed, staged, unstaged and untracked paths without mutating the worktree. Callers must select an explicit base commit; ambiguous refs are rejected, Git optional locks and filesystem monitors are disabled, and bounded output is decoded as strict UTF-8.
- `analyze:imports` resolves TypeScript/JavaScript imports, exports, dynamic imports and `require` calls from the current Git worktree. It includes untracked, non-ignored source files, excludes deleted paths and ignores type-only edges during runtime reachability.
- `verify:boundaries` consumes that graph to check renderer/preload main-process reachability, reverse `shared` dependencies and root IPC composition. CI enforces the complete rule set.

Move app-shell and antigravity-runtime IPC composition into their owning modules. Move Antigravity application-target selection to `src/shared/platform`, because it is a platform primitive used by multiple features. Move Antigravity state backup, restore and database IPC behavior from shared persistence into the account feature; shared persistence retains only generic SQLite primitives. `src/ipc/router.ts` applies global ORPC behavior and composes feature router records, retaining the existing public RPC shape.

## Alternatives considered

- Keep known boundary violations as a baseline and fail only on growth. Rejected because it normalizes debt and weakens the signal.
- Leave account backup/restore under shared persistence and move account types into shared. Rejected because the behavior owns account policy and backup semantics; only the cross-feature application-target primitive belongs in shared infrastructure.
- Analyze only Git-index paths and require agents to stage before verification. Rejected because a read-only pre-commit gate must not mutate or depend on the index.

## Consequences

- CI gains deterministic governance evidence before static and unit checks, with read-only checkout credentials and a bounded job timeout.
- All runtime boundary rules fail CI immediately; the report command remains available for diagnostics.
- Account state persistence has a feature owner, while application-target selection and credential token input are narrow shared contracts with multiple consumers.
- The scripts are intentionally read-only: no fetch, checkout, reset, index mutation or generated source output is permitted.

## Verification

- `node --test scripts/change-scope.test.mjs`
- `node --test scripts/import-graph.test.mjs`
- `node --test scripts/verify-runtime-boundaries.test.mjs`
- `node scripts/verify-runtime-boundaries.mjs --report`
- `node scripts/verify-runtime-boundaries.mjs`
- `npm run check:governance`
- `npm run type-check`

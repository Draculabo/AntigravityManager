# Agent Note: Shared local and CI checks

Status: implemented

## Problem

Independent npm aggregates and workflow command lists can drift. A check present in a local aggregate previously had no invocation in the Tests workflow. Submission checks also did not inspect staged code for ESLint errors, allowing a corrected worktree to hide invalid index content.

## Decision

Keep check commands, arguments, purpose descriptions, local groups and CI assignments in `scripts/quality/checks.mjs`. Existing npm aggregates delegate to a sequential runner. The test, lint and format workflow jobs select their registered lanes rather than maintaining leaf command lists. The complete local selection executes every entry once. Focused development commands remain available.

Run quality contracts in every CI lane and for affected staged governance paths. They validate npm aggregate wiring, registered command existence, purpose descriptions, actual required job invocations, unconditional failure propagation and declared platforms. Running the contract in other lanes lets a surviving job detect missing test wiring. Workflow scheduling and branch protection remain external requirements.

Classify every npm verification entry point as a CI leaf, an aggregate or an explained additional command. The inventory lists aliases, nested harnesses and manually selected checks without adding them to automatic execution. New verification commands cannot silently remain undiscoverable. Native, graphical and live scenarios retain explicit selection and their existing authorization requirements.

Lint JavaScript and TypeScript index blobs before commit using the current worktree ESLint configuration. Respect its ignore rules, exclude staged deletions and inspect renamed code at its destination. Apply no fixes, stashes or staging. Configuration and governance checks still observe the worktree; their results do not attest to a different committed configuration.

## Alternatives considered

**Maintain another CI command allowlist.** A second leaf list recreates the drift. The registry assigns each check to a lane; contracts inspect actual entry points.

**Copy a general parallel task scheduler.** Current checks need ordered failure propagation and existing CI jobs already provide separation. A sequential runner keeps execution, reports and failure ownership explicit.

**Lint working files or automatically stage fixes.** Working files can differ from the intended commit. Rewriting and staging can consume unrelated edits. Index-only input preserves the user's selected content.

**Run all application tests on every commit.** The submission baseline stays limited to deterministic checks. Full unit, acceptance, native and live evidence retains its owning selection policy.

## Consequences

Adding a registered check requires its explanation and CI assignment. The executable inventory is discoverable from the script guide without duplicating the command list. A failed child stops execution, keeps its exit information and leaves later checks visibly not run. Shared contracts cannot establish remote execution, native integration or live-provider correctness. Local rollback restores the previous npm/workflow entry points and removes the staged lint job; no application data or durable formats change.

## Verification

The original hook accepted staged `debugger` code despite a corrected worktree; its new regression failed before the lint job was connected. The actual contract validator rejected the old independently maintained npm/workflow setup. A new unclassified verification command also passed before classification enforcement was added and failed afterward.

On Windows with Node 24 and on Linux with Node 22.23.3, all 18 quality tests and all 15 installed-hook integration tests passed. The quality tests cover lost CI wiring, conditional or suppressed required checks, Windows matrix loss, missing npm commands, replacement of the contract command, argument forwarding, failure propagation and side-effect-free inventory listing. Installed hooks cover invalid index code hidden by a clean worktree, valid index code with invalid unstaged edits, source rename/deletion, CI governance selection and existing hook recovery. Linux uses a temporary Node runtime and matching Lefthook binary; project dependencies and user Git configuration remain unchanged.

The shared governance selection passed its actual Agent, quality, change-scope, import and boundary checks on Windows. Final ESLint, formatting and Agent-contract results accompany the change. No application source, dependency versions, native stores or release behavior changed. The full application suite and remote GitHub workflow execution were not repeated for this script-only change; live, graphical and installer acceptance remain separate.

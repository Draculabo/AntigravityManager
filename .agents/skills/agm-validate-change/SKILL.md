---
name: agm-validate-change
description: Define acceptance and select focused evidence before implementing an Antigravity Manager change, then validate the actual diff before reporting completion. Do not use for read-only analysis or semantic code review.
---

# Validate an Antigravity Manager Change

Validate the behavior a diff can affect without reflexively running the full repository suite. [Testing strategy](../../../docs/testing.md) owns the change-to-evidence mapping; the nearest `AGENTS.md` owns additional requirements.

## Plan and inspect the change

1. Confirm the repository root, branch and starting worktree state. Separate this task's files from pre-existing user changes.
2. Before implementation, apply the [behavioral evidence contract](../../../docs/testing.md#behavioral-evidence-contract) to the requested outcome and inspect relevant [Agent lessons](../../lessons.md) and their owning checks. Record acceptance, preserved behavior, applicable prevention actions and environment limits in the task record. Keep planned checks distinct from executed results; a separate tracked document is unnecessary.
3. Classify intended paths as documentation/governance, renderer UI, routing, IPC/preload, Electron main lifecycle, persistence/security, proxy protocol/server, build/update or shared contract. Identify behavior that crosses categories; it needs evidence from each affected side.
4. After implementation, compare the actual diff with that scope. For current worktree changes, run `pnpm run change-scope --base HEAD`. For outgoing commits or a pull request, verify the actual target base and head first, then pass those refs with `--base` and `--head`. Never guess a base or head. Keep the report output bounded; compare it with the starting state, then inspect task-owned changes while excluding pre-existing user-owned files.
5. Update acceptance and affected checks when requirements, consumers or the diff change. Execute newly required or invalidated checks before reporting the revised outcome.

## Select evidence

- For a regression, establish a safe negative control and the repaired result through the relevant path, plus a neighboring valid case that must remain supported. Use isolated historical inputs or a scoped mutation; preserve user-owned work. Record unavailable controls as evidence gaps. Scale native, packaged and live checks with the existing matrix.
- Locate an existing runner in [scripts/README.md](../../../scripts/README.md), then follow [scripts/AGENTS.md](../../../scripts/AGENTS.md) before execution. Use its prerequisites, effects and evidence limits to select the check; add a runner only for a demonstrated coverage gap.
- When tests or fixtures acquire resources, mutate global state or depend on asynchronous/platform behavior, use [test reliability](../../../docs/test-reliability.md) to establish isolation, readiness and cleanup before selecting commands. Use its diagnosis procedure for intermittent failures.
- Start with the owning unit or integration test file.
- Add `pnpm run type-check` for shared types, public exports, IPC contracts and module-boundary changes.
- Add `pnpm run check:agent-contracts` for `AGENTS.md`, governance docs, Agent Notes or project Skills.
- The same check covers [upgrade guide](../../../docs/upgrade-guides/README.md) structure and explicit note replacement links. It does not prove that a migration, recovery or downgrade works; run the owning behavior checks and report unavailable environment evidence.
- Run Prettier against changed documentation paths. Avoid the repository-wide `pnpm run format` when unrelated untracked trees exist under the repository root.
- Add focused Playwright evidence for user flows that require the packaged Electron boundary, not for a purely local component change.
- Add packaging, native keyring, updater or live-provider evidence only when the diff can affect that environment-dependent path.
- Use the full local rehearsal only when the change is repository-wide, CI is being diagnosed, or the user explicitly requests it.
- When a PR base, head or merge base changes after validation, recalculate the changed paths and rerun only evidence affected by the new diff. Retain earlier evidence only for unchanged behavior and inputs.
- After a review fix, map the new diff and affected consumers to the evidence matrix. Identify which earlier results remain applicable and rerun invalidated checks, including the original regression check when its behavior or inputs changed. Use the review skill's stable finding IDs when linking evidence to a fix; semantic review itself does not select or rerun checks.

Do not use a passing mock-only test as proof of native Electron, keyring, installer or live-provider behavior. Do not repeat an already passing command unless later edits invalidated its evidence.

The [Git hooks](../../../docs/development.md#local-git-checks) run staged whitespace and code lint, conditional Agent/quality contracts and a pre-push type-check. Code lint reads index blobs with the current ESLint configuration. Do not manually repeat type-check solely to precede a push; the hook runs it. These checks do not replace focused behavior evidence, and worktree configuration/contracts do not attest to a different staged or pushed snapshot. For check registration, runner or CI wiring changes, run `pnpm run test:quality` and `pnpm run check:quality`; use `pnpm run check:ci --list` to inspect the shared inventory without executing the full selection.

## Handle results

If a relevant check fails, diagnose that failure before widening scope. Do not skip it, weaken assertions or attribute it to the environment without concrete environment evidence. Stop when fixing it would require authority or scope beyond the requested change.

At task completion, apply the reflection and capture criteria in [Agent lessons](../../lessons.md). Later CI failures, user reports, reopened issues and rollbacks return through that same process; a prior passing result does not clear a newly demonstrated failure.

## Pull request checks

After a user-authorized push, inspect CI checks for the exact pushed head. Report queued or running checks as pending and failed checks as failures; do not describe pending checks as passing. Add stack synchronization or history-rewrite steps only if the project adopts stacked pull requests.

Report:

- changed behavior and affected surfaces;
- commands actually run and their results;
- environment-dependent or broader checks not run;
- residual risk that the executed evidence does not cover.

For PR descriptions, include the tested revision/artifact and environment with each result. Follow
the contribution guide's [risk and recovery assessment](../../../CONTRIBUTING.md#risk-and-recovery):
separate side effects, executed restoration and untested procedures. Keep platform, account/client
variants and mock/native/live evidence limits explicit; preparation and a code revert alone do not
establish restored persistent state.

Use [agm-code-review](../agm-code-review/SKILL.md) to review the final semantic diff after validation. Do not repeat already-passing checks during that review.

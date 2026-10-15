---
name: agm-validate-change
description: Establish change scope and select focused validation evidence for an Antigravity Manager change. Use after implementation or before reporting work complete; do not use for read-only analysis or semantic code review.
---

# Validate an Antigravity Manager Change

Validate the behavior a diff can affect without reflexively running the full repository suite. [Testing strategy](../../../docs/testing.md) owns the change-to-evidence mapping; the nearest `AGENTS.md` owns additional requirements.

## Inspect the change

1. Confirm the repository root, branch and starting worktree state. Separate this task's files from pre-existing user changes.
2. For current worktree changes, run `npm run change-scope -- --base HEAD`. For outgoing commits or a pull request, verify the actual target base and head first, then pass those refs with `--base` and `--head`. Never guess a base or head. Keep the report output bounded; compare it with the starting state, then inspect task-owned changes while excluding pre-existing user-owned files.
3. Classify each task-owned changed path as documentation/governance, renderer UI, routing, IPC/preload, Electron main lifecycle, persistence/security, proxy protocol/server, build/update or shared contract.
4. Identify behavior that crosses more than one category; those paths need evidence from each affected side.

## Select evidence

- Locate an existing runner in [scripts/README.md](../../../scripts/README.md), then follow [scripts/AGENTS.md](../../../scripts/AGENTS.md) before execution. Use its prerequisites, effects and evidence limits to select the check; add a runner only for a demonstrated coverage gap.
- When tests or fixtures acquire resources, mutate global state or depend on asynchronous/platform behavior, use [test reliability](../../../docs/test-reliability.md) to establish isolation, readiness and cleanup before selecting commands. Use its diagnosis procedure for intermittent failures.
- Start with the owning unit or integration test file.
- Add `npm run type-check` for shared types, public exports, IPC contracts and module-boundary changes.
- Add `npm run check:agent-contracts` for `AGENTS.md`, governance docs, Agent Notes or project Skills.
- The same check covers [upgrade guide](../../../docs/upgrade-guides/README.md) structure and explicit note replacement links. It does not prove that a migration, recovery or downgrade works; run the owning behavior checks and report unavailable environment evidence.
- Run Prettier against changed documentation paths. Avoid the repository-wide `npm run format` when unrelated untracked trees exist under the repository root.
- Add focused Playwright evidence for user flows that require the packaged Electron boundary, not for a purely local component change.
- Add packaging, native keyring, updater or live-provider evidence only when the diff can affect that environment-dependent path.
- Use the full local rehearsal only when the change is repository-wide, CI is being diagnosed, or the user explicitly requests it.
- When a PR base, head or merge base changes after validation, recalculate the changed paths and rerun only evidence affected by the new diff. Retain earlier evidence only for unchanged behavior and inputs.

Do not use a passing mock-only test as proof of native Electron, keyring, installer or live-provider behavior. Do not repeat an already passing command unless later edits invalidated its evidence.

The [Git hooks](../../../docs/development.md#local-git-checks) run staged whitespace and code lint, conditional Agent/quality contracts and a pre-push type-check. Code lint reads index blobs with the current ESLint configuration. Do not manually repeat type-check solely to precede a push; the hook runs it. These checks do not replace focused behavior evidence, and worktree configuration/contracts do not attest to a different staged or pushed snapshot. For check registration, runner or CI wiring changes, run `npm run test:quality` and `npm run check:quality`; use `npm run check:ci -- --list` to inspect the shared inventory without executing the full selection.

## Handle results

If a relevant check fails, diagnose that failure before widening scope. Do not skip it, weaken assertions or attribute it to the environment without concrete environment evidence. Stop when fixing it would require authority or scope beyond the requested change.

When the change follows a regression, repeated CI failure, reopened issue, rollback or failed live acceptance, apply the capture criteria in [Agent lessons](../../lessons.md). Record a candidate only when the evidence shows a reusable prevention gap; link the test, script or review rule that should prevent recurrence.

## Pull request checks

After a user-authorized push, inspect CI checks for the exact pushed head. Report queued or running checks as pending and failed checks as failures; do not describe pending checks as passing. Add stack synchronization or history-rewrite steps only if the project adopts stacked pull requests.

Report:

- changed behavior and affected surfaces;
- commands actually run and their results;
- environment-dependent or broader checks not run;
- residual risk that the executed evidence does not cover.

Use [agm-code-review](../agm-code-review/SKILL.md) to review the final semantic diff after validation. Do not repeat already-passing checks during that review.

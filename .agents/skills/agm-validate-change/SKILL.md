---
name: agm-validate-change
description: Select and run the smallest reliable validation set for an Antigravity Manager worktree change. Use after implementing repository changes or before claiming they are validated; do not use for read-only analysis.
---

# Validate an Antigravity Manager Change

Validate the behavior a diff can affect without reflexively running the full repository suite. [Testing strategy](../../../docs/testing.md) owns the change-to-evidence mapping; the nearest `AGENTS.md` owns additional requirements.

## Inspect the change

1. Confirm the repository root, branch and worktree status.
2. Inspect staged, unstaged and relevant untracked files without modifying unrelated user work.
3. Classify each changed path as documentation/governance, renderer UI, routing, IPC/preload, Electron main lifecycle, persistence/security, proxy protocol/server, build/update or shared contract.
4. Identify behavior that crosses more than one category; those paths need evidence from each affected side.

## Select evidence

- Start with the owning unit or integration test file.
- Add `npm run type-check` for shared types, public exports, IPC contracts and module-boundary changes.
- Add `npm run check:agent-contracts` for `AGENTS.md`, governance docs, Agent Notes or project Skills.
- Add focused Playwright evidence for user flows that require the packaged Electron boundary, not for a purely local component change.
- Add packaging, native keyring, updater or live-provider evidence only when the diff can affect that environment-dependent path.
- Use the full local rehearsal only when the change is repository-wide, CI is being diagnosed, or the user explicitly requests it.

Do not use a passing mock-only test as proof of native Electron, keyring, installer or live-provider behavior. Do not repeat an already passing command unless later edits invalidated its evidence.

## Handle results

If a relevant check fails, diagnose that failure before widening scope. Do not skip it, weaken assertions or attribute it to the environment without concrete environment evidence. Stop when fixing it would require authority or scope beyond the requested change.

Report:

- changed behavior and affected surfaces;
- commands actually run and their results;
- environment-dependent or broader checks not run;
- residual risk that the executed evidence does not cover.

---
name: agm-validate-change
description: Select focused validation evidence and review the final semantic diff for an Antigravity Manager change. Use after implementation or before reporting work complete; do not use for read-only analysis.
---

# Validate and Review an Antigravity Manager Change

Validate the behavior a diff can affect without reflexively running the full repository suite. [Testing strategy](../../../docs/testing.md) owns the change-to-evidence mapping; the nearest `AGENTS.md` owns additional requirements.

## Inspect the change

1. Confirm the repository root, branch and starting worktree state. Separate this task's files from pre-existing user changes.
2. For current worktree changes, run `npm run change-scope -- --base HEAD`. For outgoing commits, verify the actual target base first, then pass it with `--base`; use `--head` only for a specific head other than `HEAD`. Never guess a base. Keep the report output bounded; compare it with the starting state, then inspect task-owned changes while excluding pre-existing user-owned files.
3. Classify each task-owned changed path as documentation/governance, renderer UI, routing, IPC/preload, Electron main lifecycle, persistence/security, proxy protocol/server, build/update or shared contract.
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

## Review the final diff

After relevant fixes and checks, review the task-owned final diff once for defects that mechanical gates may miss. Use the exact scope established above and read the nearest `AGENTS.md` plus the relevant [architecture](../../../docs/architecture.md), [security](../../../docs/security.md), [testing](../../../docs/testing.md) and Agent Note guidance.

- Trace changed interfaces in both directions. Check ownership, validation, transformations and dependency direction against the module and process boundaries.
- Follow failure paths to their final state and user-visible result. Check cancellation, retries, concurrency, timeouts, partial completion and resource cleanup.
- For persistence, credentials, authentication, IPC, process execution, packaging or updates, verify trust boundaries, data exposure and recovery behavior.
- For UI changes, check asynchronous states, error and empty states, accessibility, localization ownership and whether copy or diagnostics match actual behavior.
- For behavior changes, confirm tests would fail for the intended regression. For asynchronous, native, platform-sensitive or resource-owning tests, inspect isolation, synchronization, timeouts and cleanup; mocks do not prove native or packaged behavior.
- Confirm documentation and comments match current behavior and implemented Agent Notes match the changed code. Check for unrelated task files, generated output, secrets and user-owned paths.

Report actionable findings before summary. Each finding needs a precise file and line, impact, and evidence from the diff or execution path. Separate blockers from non-blocking suggestions. Omit style preferences, speculative risks and issues already covered by passing mechanical checks. If there are no findings, say so and name any important behavior the review could not verify.

Report:

- changed behavior and affected surfaces;
- commands actually run and their results;
- environment-dependent or broader checks not run;
- residual risk that the executed evidence does not cover.

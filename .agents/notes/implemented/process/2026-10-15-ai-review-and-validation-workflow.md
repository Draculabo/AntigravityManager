# Agent Note: AI review and validation workflow

Status: implemented

## Problem

The repository already had a detailed testing matrix and focused validation skill, but the root change workflow did not route different task types or require bug reproduction before implementation. Validation and semantic review also shared one skill, while the matrix did not make several cross-boundary and environment-dependent evidence routes explicit.

## Decision

- Require contribution risk, revision-scoped evidence and recovery reporting in the existing PR template; [contribution guidance](../../../../CONTRIBUTING.md#risk-and-recovery) owns the levels and human confirmation.
- Keep review rounds, stable finding IDs, resolution evidence and escalation after three substantive unresolved rounds in the existing review skill. Follow-up reviews trace fixes and affected consumers; the limit never clears a defect. This preserves bounded human attention without adding an automatic merge path.
- Keep the [historical evaluation](../../../../docs/testing/review-evaluation.md) optional for a specific reviewer failure or comparative performance question. Separate source inputs from evaluator rubrics and require human adjudication; harness/probe passes are not model performance results. Current-task acceptance remains the default evidence, without a CI baseline project, scheduled review or CI workflow change.
- Route read-only investigations, bug fixes, routine features and multi-boundary or high-risk changes differently in the root instructions.
- Reproduce or isolate a reported bug and define the observable regression check before changing code.
- Require a concise plan for multi-module or high-risk work, and preserve durable decisions in Agent Notes.
- Invoke [agm-validate-change](../../../skills/agm-validate-change/SKILL.md) before implementation to define acceptance and select focused checks, then return to it to inspect the actual diff and report executed results. Relevant experience is consulted before editing through the [learning loop](2026-10-15-agent-learning-loop.md), which also owns completion reflection and post-delivery feedback.
- Establish input provenance, the exercised entry and substituted boundaries, and the caller-visible observable before selecting checks, using the [behavioral evidence contract](../../../../docs/testing.md#behavioral-evidence-contract). Regression evidence includes a safe negative control, repaired result and preserved neighboring behavior; unavailable evidence remains a gap. Keep this record in the task report rather than adding a document per task.
- Give [agm-code-review](../../../skills/agm-code-review/SKILL.md) a separate, independently callable responsibility for semantic review of implementation diffs and pull requests.
- Use the repository's existing `npm` scripts and [testing matrix](../../../../docs/testing.md#change-to-evidence-matrix). Reserve exhaustive test and platform coverage for CI or changes that affect those surfaces.
- Map shared types and module boundaries, cross-module user flows, governance files, native integrations and cross-platform behavior to minimum evidence and the conditions for widening it.
- For pull requests, verify the actual base and head, re-evaluate affected evidence after a base or history change, and distinguish pending CI checks from failures after an authorized push. Add stacked-pull-request procedures only if the project adopts that workflow.
- Format changed documentation paths directly. For `.agents/` paths, pass an empty temporary Prettier ignore file because `.prettierignore` excludes that tree; reserve the recursive repository format script for workspaces without unrelated untracked trees.
- Treat semantic review and executed validation as separate evidence: review does not replace tests, and a passing test does not replace review.
- Use [the script guide](../../../../scripts/README.md) as the discovery entry for agent verification and preparation tools. [Script instructions](../../../../scripts/AGENTS.md) require existing-runner reuse, explicit effects and cleanup evidence; build and release operations keep their own scope.
- Keep resource isolation, readiness, full teardown and intermittent-failure diagnosis in [test reliability](../../../../docs/test-reliability.md). Keep partial effects, unknown outcomes, recovery ownership and truthful reports in [failure ownership](../../../../docs/error-handling.md). Root instructions and the two Skills link these references only for affected work.
- Include these references and script instructions in agent-contract checks, with negative fixtures for missing files, broken links and missing command references.
- Use the locked Lefthook development dependency for shared commit/push checks. The [hook reference](../../../../docs/development.md#local-git-checks) owns current jobs and their index/worktree evidence limits. Preserve read-only checks and the previous pre-commit hook. Push runs type-check unconditionally so initial branches need no guessed comparison base. CI retains exhaustive gates and runs the isolated hook integration tests.
- Keep [hook lifecycle and recovery](../../../../docs/development.md#local-git-checks) in the development reference. Installation uses no force flags or configuration reset, preserves the existing pre-commit hook and refuses custom hook paths or unmanaged pre-push hooks. The pre-commit adapter disables automatic unstaged-change hiding because the jobs are read-only.

## Alternatives considered

**Keep validation and semantic review in one skill.** This makes review-only work load test-selection instructions and blurs which evidence each skill owns.

**Require a heavyweight plan for every task.** Read-only questions and bounded fixes do not need extra artifacts; scale planning to the number of affected boundaries and the recovery cost.

**Add more general reminders after each failure.** Recent failures include implementation-shaped binary fixtures, a parent queue missed by worker-local optimization and acceptance snapshots retaining external destinations. The existing real-evidence rules already apply. Make validation identify the actual input and entry, make review challenge those claims, and retain these defect classes in the existing historical corpus. Probe sensitivity does not establish reviewer performance.

**Require an offline model comparison for every workflow edit.** A source-only historical audit
does not exercise real development or show reduced rework. Select it for a concrete reviewer
question, and assess workflow changes through acceptance and later failure feedback on real tasks.

**Run full behavior or platform suites in local hooks.** Their cost and environment requirements do not match every commit or push. Keep the local gates deterministic and narrow; select behavior evidence separately and retain the full matrix in CI.

**Select outgoing files to skip some pre-push type-checks.** New branches, rewritten refs and multiple pushed refs complicate comparison. The measured type-check cost supports a single unconditional check without another ref-selection implementation.

**Use default pre-commit partial-staging handling.** The installed Lefthook version hides unstaged changes even for read-only jobs. Its supported `--no-stage-fixed` flag avoids that mutation and the unborn-branch stash failure. Keep the small CLI adapter until a supported configuration-only option preserves the same behavior.

**Run repository-wide formatting for every documentation edit.** The format script recursively scans the root and can enter user-owned worktrees; formatting only changed paths gives scoped evidence.

**Create another verification runner or command catalog.** The repository already has a dispatcher, npm commands and scenario-specific SOPs. Route agents to those owners; add a runner only for a demonstrated coverage gap.

**Add a Skill for every specialized rule.** Reliability and failure handling serve existing implementation, validation and review steps. Linked references keep the trigger-specific detail out of the always-loaded instructions without adding more Skill entry points.

## Consequences

Implementation work follows a risk-scaled sequence: route the task, preserve the starting worktree,
consult relevant safeguards, define acceptance, diagnose before fixing, implement a coherent slice,
validate with focused evidence, review the final diff and assess prevention gaps. Validation and
review have separate skills; `docs/testing.md` owns the evidence matrix. Script discovery, reliable
execution and failure-state review use existing tools and focused references. Lefthook reduces
missed baseline checks but reads worktree state for contracts and types; it cannot certify a
different staged or outgoing snapshot. No OpenSpec files or prompts are changed, and OpenSpec is
not invoked automatically.

## Verification

The 2026-10-30 task-integrated routing passes `pnpm run check:agent-contracts` (28 tests and
the document validator). Acceptance now precedes implementation; historical model evaluation
is optional. These structural checks do not establish workflow effectiveness.

A subsequent source-only comparison completed 20 reviews across the five historical defects
and repaired controls. Provisional model-assisted interpretation found all five targets under
both instruction sets and one harmful quota reversal under each; human adjudication remains
pending. Missing contracts and linked context limit the comparison. It demonstrates no detection
gain and does not measure acceptance quality or rework on real tasks.

The 2026-10-30 evidence-contract extension passes all 10 historical-evaluation tests, including
the three new defect/repair probes, complete five-case preparation and rejection of missing
repair-only sources. `pnpm run test:quality` passes all 23 tests and `pnpm run check:quality`
passes with the expanded test-file selection. Checks use Node 24.22.0 and pnpm 10.34.6.
The probes establish their documented synthetic or temporary-filesystem behavior only. At that
extension's verification, no model comparison or human adjudication had been performed. The
implementation session had seen the evaluator answers and could not supply a blind review result.

The initial workflow split passed agent contracts, type-check, focused formatting and whitespace checks. The measured type-check took about 8.5 seconds and agent contracts about 2–3 seconds; these few observations cannot establish a failure rate. Before Lefthook integration, `core.hooksPath` was unset and CodeGraph owned the local pre-commit hook. No stacked-pull-request workflow was found. OpenSpec files remain unchanged.

The reliability and script-routing extension adds three negative fixtures. All three failed against the preceding checker: missing references were accepted, and invalid links and commands in the new locations were ignored. After extending the checker, all 8 agent-contract tests passed. `npm run check:governance` passed all 21 tests and both runtime/type-boundary checks. Focused ESLint and Prettier checks passed, and `git diff --check` passed. The unified acceptance help command was checked against the script guide. No native, live-account, provider, installer or release operation was run; this change updates agent guidance and its validator rather than application behavior or acceptance runners.

All 11 hook integration tests passed on Windows using real rejected commits and a local bare remote. They cover partial staging without a stash, governance additions/deletions/renames, failed and successful pushes, manual pre-push without outgoing files, installation skips, existing hooks and uninstall recovery. The adapter forces pre-push execution because Lefthook otherwise skips an empty outgoing file list. Installation also detects an old pre-push hook already preserved by the dependency's install step.

The installed project's pre-commit jobs passed, including agent contracts and the preserved CodeGraph hook. The actual pre-push job executed and passed type-check in about 9.75 seconds. SHA-256 comparisons confirmed that the original index and preserved pre-commit hook were unchanged, and `core.hooksPath` remained unset. Lefthook configuration validation, focused ESLint and Prettier, and whitespace checks passed. Terminal evidence does not verify GUI Git clients or native macOS/Linux hook execution. No project commit or remote push was performed.

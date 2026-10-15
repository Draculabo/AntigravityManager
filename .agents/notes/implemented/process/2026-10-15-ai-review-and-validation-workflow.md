# Agent Note: AI review and validation workflow

Status: implemented

## Problem

The repository already had a detailed testing matrix and focused validation skill, but the root change workflow did not route different task types or require bug reproduction before implementation. Validation and semantic review also shared one skill, while the matrix did not make several cross-boundary and environment-dependent evidence routes explicit.

## Decision

- Route read-only investigations, bug fixes, routine features and multi-boundary or high-risk changes differently in the root instructions.
- Reproduce or isolate a reported bug and define the observable regression check before changing code.
- Require a concise plan for multi-module or high-risk work, and preserve durable decisions in Agent Notes.
- Keep [agm-validate-change](../../../skills/agm-validate-change/SKILL.md) responsible for establishing change scope, selecting focused checks and reporting validation results.
- Give [agm-code-review](../../../skills/agm-code-review/SKILL.md) a separate, independently callable responsibility for semantic review of implementation diffs and pull requests.
- Use the repository's existing `npm` scripts and [testing matrix](../../../../docs/testing.md#change-to-evidence-matrix). Reserve exhaustive test and platform coverage for CI or changes that affect those surfaces.
- Map shared types and module boundaries, cross-module user flows, governance files, native integrations and cross-platform behavior to minimum evidence and the conditions for widening it.
- For pull requests, verify the actual base and head, re-evaluate affected evidence after a base or history change, and distinguish pending CI checks from failures after an authorized push. Add stacked-pull-request procedures only if the project adopts that workflow.
- Format changed documentation paths directly. For `.agents/` paths, pass an empty temporary Prettier ignore file because `.prettierignore` excludes that tree; reserve the recursive repository format script for workspaces without unrelated untracked trees.
- Treat semantic review and executed validation as separate evidence: review does not replace tests, and a passing test does not replace review.

## Alternatives considered

**Keep validation and semantic review in one skill.** This makes review-only work load test-selection instructions and blurs which evidence each skill owns.

**Require a heavyweight plan for every task.** Read-only questions and bounded fixes do not need extra artifacts; scale planning to the number of affected boundaries and the recovery cost.

**Add mandatory local test hooks immediately.** The repository has no project-managed hook framework. Local checks are fast in the measured run, but one successful run does not establish a stable failure rate; defer a managed hook until the project selects a shared installation mechanism and gathers repeated evidence.

**Run repository-wide formatting for every documentation edit.** The format script recursively scans the root and can enter user-owned worktrees; formatting only changed paths gives scoped evidence.

## Consequences

Implementation work follows a risk-scaled sequence: route the task, preserve the starting worktree, diagnose before fixing, implement a coherent slice, validate with focused evidence, review the exact final diff, then report results and remaining gaps. Validation and review have separate skills; `docs/testing.md` owns the evidence matrix. No OpenSpec files or prompts are changed, and OpenSpec is not invoked automatically. A project-managed hook is deferred until measured cost and reliability justify adding one.

## Verification

`npm run check:agent-contracts` passed (5 tests, about 2–3 seconds), `npm run type-check` passed (about 8.5 seconds), focused Prettier passed (about 0.7–1 second), and `git diff --check` passed (about 0.14–0.17 seconds). No false failure occurred in the observed runs; the sample is too small to estimate a failure rate. `core.hooksPath` is unset, the current local pre-commit hook is installed by CodeGraph, and no project-managed hook setup was found, so this change does not add a hook framework or modify Git configuration. No stacked-pull-request workflow was found. OpenSpec files remain unchanged.

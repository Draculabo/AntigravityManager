# Agent Note: AI review and validation workflow

Status: implemented

## Problem

The repository already had focused validation guidance and a detailed testing reference, but the root change workflow did not define a reusable semantic review after implementation. Change-scope inspection, test selection and final code review could therefore be applied inconsistently or repeated without adding evidence.

## Decision

- Keep [agm-validate-change](../../../skills/agm-validate-change/SKILL.md) responsible for establishing change scope, selecting focused checks and reviewing the final semantic diff.
- Link this procedure from the root change workflow while keeping detailed checklists in the project Skill.
- Use the repository's existing `npm` scripts and testing matrix. Reserve exhaustive test and platform coverage for CI or changes that affect those surfaces.
- Treat semantic review and executed validation as separate evidence: review does not replace tests, and a passing test does not replace review.

## Alternatives considered

**Keep final review informal.** This leaves semantic checks dependent on each agent's memory and makes reports inconsistent.

**Copy another repository's hooks, scripts or CI workflow.** Those mechanisms encode different tooling and test boundaries and would conflict with this repository's existing validation system.

**Expand the root `AGENTS.md` with the complete review checklist.** This would load task-specific detail for every task and duplicate the purpose of project Skills.

## Consequences

Implementation work follows a clear sequence: inspect and implement, validate with focused evidence, review the exact final diff, then report results and remaining gaps. The existing validation skill remains the single entry point for this procedure, and the root instructions stay concise.

## Verification

The workflow uses the repository's `change-scope` and `check:agent-contracts` scripts. `npm run check:agent-contracts` passed, and the touched Markdown files passed a focused Prettier check. The full `npm run format` scan was started but did not complete in the available run time.

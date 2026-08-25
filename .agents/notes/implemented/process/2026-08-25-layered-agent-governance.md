# Agent Note: Layered agent governance

Status: implemented

## Problem

The root `AGENTS.md` mixed stable agent orders with the technology inventory, directory map, command reference, architecture guidance, generic quality advice and a harness-specific subagent workflow. Every task loaded all of that material, while important rules had no single owner or executable freshness check.

## Decision

Agent governance is layered by responsibility:

- The root `AGENTS.md` contains repository-wide standing orders and links to authoritative detail.
- Subtree `AGENTS.md` files contain only rules unique to their code area.
- `docs/architecture.md`, `docs/development.md`, `docs/testing.md` and `docs/security.md` own current technical references.
- Agent Notes own durable decision rationale and rejected alternatives.
- Project Skills own reusable procedures that should not occupy every agent context.
- `check-agent-contracts.mjs` validates the mechanically decidable parts of the governance system.

Focused validation is the local default. The changed runtime surface determines the evidence; complete E2E, packaging and platform matrices are reserved for affected changes, CI or explicit full rehearsals.

## Alternatives considered

**Keep expanding the root file.** This preserves a single visible document but increases context cost, duplicates authoritative files and makes scope-specific rules apply everywhere.

**Store all guidance in Skills.** Skills are useful for procedures but are loaded conditionally. Architecture and safety constraints that must apply to every relevant change still need root or subtree instructions and current reference documents.

## Consequences

Agents load a shorter root contract and discover detail through scope and task type. Maintainers must update the owning document instead of repeating a fact elsewhere. High-risk decisions gain an explicit rationale record, while routine changes avoid documentation ceremony.

The governance system now has more files, so broken links, stale script references and invalid Agent Note lifecycle metadata require an automated gate. Code dependency boundaries remain prose-only until existing imports are audited and an enforceable baseline is introduced separately.

## Verification

The repository provides `npm run check:agent-contracts` to validate required governance files, local links, referenced npm scripts, root line budget and Agent Note structure. Its Node test suite includes known-invalid fixtures so a broken link and lifecycle mismatch prove that the gate can fail.

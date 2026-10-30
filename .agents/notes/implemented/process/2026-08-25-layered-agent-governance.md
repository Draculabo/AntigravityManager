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

The [skill maintenance reference](../../../../docs/development/agent-skills.md) adds a read-only
inventory and explicit origin/mirror policy to that existing gate. OpenSpec's generated harness
directories remain in place; entry mirrors are checked after newline normalization instead of
being replaced with Windows-dependent links or a second generator. Only special ownership and
mirror relationships are configured; discovery supplies the catalog.

The [routing corpus and procedure](../../../../docs/testing/agent-routing.md) separate structural
contracts from observed Agent behavior. Cases cover task selection, prior workflow context and
later scope restrictions. Model execution and human adjudication remain manual; no keyword router,
automatic model lint, scheduled learning task or new publication path is introduced.

Focused validation is the local default. The changed runtime surface determines the evidence; complete E2E, packaging and platform matrices are reserved for affected changes, CI or explicit full rehearsals.

## Alternatives considered

**Keep expanding the root file.** This preserves a single visible document but increases context cost, duplicates authoritative files and makes scope-specific rules apply everywhere.

**Store all guidance in Skills.** Skills are useful for procedures but are loaded conditionally. Architecture and safety constraints that must apply to every relevant change still need root or subtree instructions and current reference documents.

**Replace generated skill copies with links.** That would transfer ownership away from the
generator and depend on harness and Windows link behavior. Checking declared entry mirrors keeps
the current integration and exposes one-sided changes without rewriting either copy.

## Consequences

Agents load a shorter root contract and discover detail through scope and task type. Maintainers must update the owning document instead of repeating a fact elsewhere. High-risk decisions gain an explicit rationale record, while routine changes avoid documentation ceremony.

The governance system has more files, so broken links, stale script references and invalid Agent Note lifecycle metadata require an automated gate. Runtime dependency enforcement has its own implementation and evidence in the [testing reference](../../../../docs/testing.md); it complements document governance without changing these ownership decisions.

## Verification

The skill and route contracts have valid controls and deliberately invalid fixtures for entry
metadata, mirror content, missing entries, provenance paths and route rubrics. These tests establish
validator behavior, not harness discovery or model routing quality. Task evidence records executed
commands and environments; independent semantic routing trials remain separate.

The 2026-10-30 extension passes 51 Agent-contract tests and the actual document validator on
Windows with Node 24.22.0 and pnpm 10.34.6. The real CLI rejects mirror drift with exit code 1.
Inventory reports 28 entries without errors or advisories. The governance aggregate, 23 quality
harness tests and quality contracts pass; focused ESLint and formatting checks cover the change.
An external-link negative control exposed a legacy body-read bypass; only validated skill paths
now enter body checks. Independent model routing trials and other OS environments remain unverified.

The repository provides `npm run check:agent-contracts` to validate required governance files, local links, referenced npm scripts, root line budget and Agent Note structure. Its Node test suite includes known-invalid fixtures so a broken link and lifecycle mismatch prove that the gate can fail.

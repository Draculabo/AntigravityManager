# Documentation Instructions

These instructions supplement the repository root [AGENTS.md](../AGENTS.md) for files under `docs/`.

## One home per fact

Give each fact one authoritative location and link to it elsewhere:

- `architecture.md`: current runtime composition, ownership and dependency direction.
- `development.md`: contributor setup, commands and environment-specific workflow.
- `testing.md`: test strategy and change-to-evidence selection.
- `security.md`: trust zones, sensitive data and high-risk boundaries.
- `.agents/notes/`: decision rationale, alternatives and consequences.
- Feature documentation: feature behavior and user-facing operation owned by that feature.

Do not copy complete command lists from `package.json`, restate source types, or reproduce another document's detailed explanation. Link to the owner and add only the context required by the current document.

## Document type and tense

State whether a document is a current reference, an ordered tutorial, or a decision record through its title and structure.

- Current references describe shipped behavior in the present tense.
- Tutorials use ordered steps, prerequisites and explicit verification.
- Future implementation plans belong in a proposed Agent Note when they represent a durable project decision.
- Historical rationale does not belong in current architecture prose.

Do not present an unimplemented plan as current behavior. When a plan ships, update the current reference and convert its decision record to implemented status.

## Writing rules

- Repository documentation is written in English unless a document is explicitly maintained as a translation.
- Use direct technical terms and explain behavior, ownership, failure modes and safe use.
- Do not narrate the author's reasoning process or preserve review history in current reference docs.
- Use a language identifier on every fenced code block; use `plaintext` when no better language applies.
- Keep links relative inside the repository.
- Update paths, commands and contracts in the same change as the code they describe.

## Validation

Run `npm run check:agent-contracts` after changing agent instructions, governance documents, Agent Notes or the project validation Skill. Run `npm run format` for all documentation changes.

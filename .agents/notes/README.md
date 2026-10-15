# Agent Notes

Agent Notes record durable project decisions: the problem, the selected approach, rejected alternatives, consequences and verification that maintainers may need when revisiting the decision. Current behavior remains documented in source, JSDoc and `docs/`; an Agent Note owns rationale rather than duplicating those contracts.

## When to write one

Add or update an Agent Note when a change affects at least one of these surfaces:

- Electron main, preload or renderer trust boundaries.
- Public IPC/ORPC request, response or error contracts.
- SQLite schema, durable payloads, configuration formats, backup or recovery behavior.
- Credential location, authentication, authorization, logging or sensitive-data handling.
- Proxy protocol compatibility, externally visible streaming semantics or durable client state.
- Cross-module dependency direction or ownership.
- Packaging, installers, updates, release behavior or executable patching.
- Repository-wide testing strategy, quality gates or agent governance.

Do not create an Agent Note for routine UI work, a local bug with an obvious fix, internal renaming, formatting or a mechanical refactor that preserves behavior and ownership.

Update the note that already owns a decision instead of creating a duplicate. A materially different decision supersedes the old note and cross-links both.

## Layout

Paths encode lifecycle and class:

```plaintext
.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md
```

Lifecycle values:

- `proposed`: reviewed before implementation; not current behavior.
- `implemented`: shipped decision, maintained to match current names and locations.
- `rejected`: considered and declined; retained only while its rationale prevents a plausible mistake.
- `archived`: an implemented decision fully replaced by another recorded decision; historical context, not current authority.

Recommended classes are `architecture`, `feature`, `bug-fix`, `process`, `security` and `testing`. Add a class only when existing classes do not describe the decision.

## Format

The first lines are:

```markdown
# Agent Note: <title>

Status: proposed | implemented | rejected — <reason>
```

Required sections:

| Lifecycle     | Required sections                                                                             |
| ------------- | --------------------------------------------------------------------------------------------- |
| `proposed`    | `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, `Risks`              |
| `implemented` | `Problem`, `Decision`, `Alternatives considered`, `Consequences`, `Verification`              |
| `rejected`    | `Problem`, `Proposal`, `Alternatives considered`                                              |
| `archived`    | Implemented sections; `Status: implemented`, archive date and reciprocal replacement metadata |

Proposed notes use future tense for intended behavior. Implemented notes describe shipped behavior in the present tense. Rejected notes keep the proposal and put the rejection reason on the status line.

Run `npm run check:agent-contracts` after adding, moving or editing an Agent Note.

## Supersession and retention

When adding or materially revising a decision, inspect active notes that address the same behavior,
alternatives or ownership. Keep an existing owner when its decision still applies. A partial change
updates that owner and explains the remaining obligations; it does not retire the entire record.
Review relevance against current implementation and tests, rather than age, word count or a target
number of files. Routine work does not trigger a repository-wide note audit.

For a complete replacement, add a `Superseded by:` line linking to the new decision and a
`Supersedes:` line on the new decision linking back to the old one. Both values are relative
Markdown links placed before the first section. Use one
replacement per retired note; a new note can repeat `Supersedes` for multiple predecessors. Only
implemented decisions declare these relationships. Links are reciprocal and chains are acyclic.
When a later decision replaces the successor, retain the chain rather than rewriting the original
historical rationale. A chain ends at a current implemented decision.

Archive a completely replaced record only when its historical rationale is still useful but no
remaining requirement depends on treating it as current. Move it to
`archived/<class>/yyyy-mm-dd-topic.md`, retain `Status: implemented`, and add
`Archived: yyyy-mm-dd` plus the replacement link before the first section. Repair active incoming
links, including the successor's `Supersedes` link. Preserve the historical body; its obsolete
paths and command examples are no longer current references. Subsequent corrections belong in a
current record, with reciprocal replacement metadata updated only when necessary. Proposed notes
remain proposed or become rejected; they are never archived as implemented work.

Delete a redundant mechanical record only after confirming it carries no useful decision rationale
or remaining references. Removing a substantive decision or unrelated user-owned record requires
the applicable task authorization. Do not move or delete notes merely to satisfy a check.

The Agent contract check validates archive status/date, existing replacement targets, reciprocal
links and cycles. It checks current notes' links and npm references, while leaving archived body
references frozen. Semantic review establishes complete replacement, remaining obligations and
whether an archive body changed; the validator does not infer those facts from code.

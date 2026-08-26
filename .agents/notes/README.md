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

Recommended classes are `architecture`, `feature`, `bug-fix`, `process`, `security` and `testing`. Add a class only when existing classes do not describe the decision.

## Format

The first lines are:

```markdown
# Agent Note: <title>

Status: proposed | implemented | rejected — <reason>
```

Required sections:

| Lifecycle | Required sections |
|---|---|
| `proposed` | `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, `Risks` |
| `implemented` | `Problem`, `Decision`, `Alternatives considered`, `Consequences`, `Verification` |
| `rejected` | `Problem`, `Proposal`, `Alternatives considered` |

Proposed notes use future tense for intended behavior. Implemented notes describe shipped behavior in the present tense. Rejected notes keep the proposal and put the rejection reason on the status line.

Run `npm run check:agent-contracts` after adding, moving or editing an Agent Note.

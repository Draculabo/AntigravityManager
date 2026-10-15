---
name: agm-code-review
description: Review a concrete Antigravity Manager diff for semantic defects, boundary violations and evidence gaps. Use for pull request reviews or the final review after implementation validation; this skill does not select or rerun tests.
---

# Review an Antigravity Manager Change

Review the exact change for defects that mechanical checks cannot establish. For implementation work, use this after [agm-validate-change](../agm-validate-change/SKILL.md) has selected and run the relevant checks. For review-only work, start here without running validation commands unless the user asks for them.

## Establish the review scope

1. Confirm the repository, branch and starting worktree state. Separate the requested change from pre-existing user changes.
2. For a pull request, verify the actual base and head from its metadata before calculating the changed paths and diff. Include any relevant uncommitted work separately; never guess either ref.
3. Read the changed code, affected consumers and the nearest `AGENTS.md`. Read the architecture, security or testing reference when the changed boundary needs it.
4. If the PR base, head or merge base changed after earlier review, recalculate the diff and review the newly affected paths. Preserve earlier findings only when their cited code and scope still match.

## Review the behavior

- **Ownership and process boundaries:** Check feature ownership, dependency direction, renderer/main isolation, and that cross-process calls use the typed preload and ORPC/IPC surface.
- **Contracts and data:** Check validation and transformations at external, persisted and process boundaries. For SQLite, Drizzle, credentials and backups, inspect privacy, atomicity, recovery and migration behavior.
- **Proxy behavior:** Trace request and response mapping through status handling, streaming, errors, cancellation and retries. Check that diagnostics retain useful context without exposing secrets.
- **Async lifecycle:** Follow success, failure, cancellation, timeout and partial-completion paths. Check race behavior, process and resource cleanup, and bounded retry behavior.
- **Failure state:** Apply [failure ownership](../../../docs/error-handling.md) to changed errors and recovery. Verify the state after partial writes, unknown remote outcomes and failed rollback; trace safe continuation and final reporting to their owners.
- **Alternate callers and limits:** Trace denials through the operation that executes them, including alternate entry points. Check retained values against their authoritative source and measure limits on the complete emitted result, including metadata and UTF-8 bytes when applicable.
- **User experience:** For UI changes, check loading, empty and error states, retry behavior, keyboard access, localization ownership and whether user-visible errors match the actual failure.
- **Evidence quality:** Confirm tests exercise an observable behavior that would fail for the regression. Match mocks, integration tests, packaged checks and native or live evidence to the behavior each can establish. Do not treat mocks as proof of native, installer, updater or live-provider behavior.
- **Runner reliability:** Apply [test reliability](../../../docs/test-reliability.md) to asynchronous, native or resource-owning tests and [script instructions](../../../scripts/AGENTS.md) to changed runners. Verify readiness, isolated resources, full teardown and a representative negative case for changed acceptance predicates. Check that the entry point matches the shipped behavior being claimed.
- **Change hygiene:** Check that current documentation and comments match behavior, Agent Notes record durable decisions, and the diff contains no unrelated files, generated output, secrets or user-owned changes.

## Report findings

Report actionable defects first, ordered by impact. Each finding includes a precise file and line, the affected behavior, impact and supporting evidence from the diff or execution path. Separate blocking findings from non-blocking suggestions. Omit style preferences, speculative risks and issues already established by passing mechanical checks.

If there are no findings, say so and identify material behavior the review could not verify. A review does not replace executed validation; report validation evidence and unverified environments separately.

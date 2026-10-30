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
5. Confirm the author's [risk and recovery assessment](../../../CONTRIBUTING.md#risk-and-recovery) from the actual behavior and consumers. Identify missing evidence and human confirmation separately from code defects.

## Review rounds and resolution

1. **First round:** Review the complete requested diff and relevant consumers, contracts and failure paths. Gather all supported findings in that pass; there is no finding quota.
2. **Follow-up rounds:** Review the changes since the previously reviewed head, verify open findings and trace consumers affected by the fixes. Expand scope for changed contracts, broader behavior or base/merge-base changes, and record why. Reuse evidence only for unchanged behavior and inputs, following the validation skill.
3. **After the third substantive round:** If blocking issues remain, stop the automatic edit/review cycle and report unresolved IDs, attempted fixes, conflicting constraints and whether to repair locally, redesign or split the change. A maintainer chooses continuation; the limit is not approval. A round is a completed review of a changed snapshot, not a clarification or repeated review of identical input. Stop earlier when findings are resolved and evidence gaps are clearly reported.

Give each finding a stable ID such as `R1`. Keep its trigger, precise file/line, traceable behavior,
impact and evidence together. State the required behavior rather than prescribing an incidental
implementation. Reopen a resolved ID only with new evidence or a regression, explaining the reason;
report the full affected scope of a defect class together instead of repeating individual instances.

Track each ID as **open**, **fixed** (revision and supporting evidence), **not a defect** (contract or
counterevidence), or **accepted limitation** (explicit human maintainer decision, impact and reason).
An agent cannot accept a limitation on the maintainer's behalf. Label pre-existing defects and
explain whether they affect this change's decision. Newly discovered serious security or data
integrity defects still require handling regardless of the round or original scope. Agreement from
another model is supporting input, not proof.

Keep this compact record in the task report or an authorized PR discussion; do not create a tracked
file per review or publish comments without authorization:

```plaintext
Reviewed base/head and worktree scope:
Round and scope changes:
Open findings:
Resolved IDs, decisions and evidence:
Validation gaps and required human confirmation:
Conclusion:
```

## Review the behavior

- **Ownership and process boundaries:** Check feature ownership, dependency direction, renderer/main isolation, and that cross-process calls use the typed preload and ORPC/IPC surface.
- **Contracts and data:** Check validation and transformations at external, persisted and process boundaries. For SQLite, Drizzle, credentials and backups, inspect privacy, atomicity, recovery and migration behavior.
- **Proxy behavior:** Trace request and response mapping through status handling, streaming, errors, cancellation and retries. Check that diagnostics retain useful context without exposing secrets.
- **Async lifecycle:** Follow success, failure, cancellation, timeout and partial-completion paths. Check race behavior, process and resource cleanup, and bounded retry behavior.
- **Failure state:** Apply [failure ownership](../../../docs/error-handling.md) to changed errors and recovery. Verify the state after partial writes, unknown remote outcomes and failed rollback; trace safe continuation and final reporting to their owners.
- **Alternate callers and limits:** Trace denials through the operation that executes them, including alternate entry points. Check retained values against their authoritative source and measure limits on the complete emitted result, including metadata and UTF-8 bytes when applicable.
- **User experience:** For UI changes, check loading, empty and error states, retry behavior, keyboard access, localization ownership and whether user-visible errors match the actual failure.
- **Evidence quality:** Check the author's [behavioral evidence contract](../../../docs/testing.md#behavioral-evidence-contract) against the diff: does the input have an independent basis, does the exercised entry traverse the failing boundary, and does the assertion establish the caller's result? Check negative-control failures and preserved neighboring behavior. Identify an implementation-derived fixture, bypassed queue/process boundary or mismatched source/build as a specific evidence gap. Match mocks, integration tests, packaged checks and native or live evidence to the behavior each can establish; review itself does not execute these checks.
- **Runner reliability:** Apply [test reliability](../../../docs/test-reliability.md) to asynchronous, native or resource-owning tests and [script instructions](../../../scripts/AGENTS.md) to changed runners. Verify readiness, isolated resources, full teardown and a representative negative case for changed acceptance predicates. Check that the entry point matches the shipped behavior being claimed.
- **Agent lessons:** Check applicable prevention actions from [Agent lessons](../../lessons.md) against the actual evidence. For a failure discovered after delivery, check the original acceptance gap. Any new candidate needs verified evidence, a supported cause and a concrete prevention check; an existing rule needs an execution or coverage repair rather than a duplicate.
- **Change hygiene:** Check that current documentation and comments match behavior, Agent Notes record durable decisions, and the diff contains no unrelated files, generated output, secrets or user-owned changes.
- **Upgrade and decision history:** For incompatible user data, configuration, CLI or public API changes, check [upgrade instructions](../../../docs/upgrade-guides/README.md) against actual migration, recovery and downgrade evidence. Follow [note retention](../../notes/README.md#supersession-and-retention) when a decision is replaced; retain partial obligations, verify replacement links and review archive-body changes as historical edits, not link maintenance.

## Report findings

Report actionable defects first, ordered by impact. Each finding includes a precise file and line, the affected behavior, impact and supporting evidence from the diff or execution path. Separate blocking findings from non-blocking suggestions. Omit style preferences, speculative risks and issues already established by passing mechanical checks.

If there are no findings, say so and identify material behavior the review could not verify. A review does not replace executed validation; report validation evidence and unverified environments separately.

Use the bounded historical [review evaluation](../../../docs/testing/review-evaluation.md) when
investigating a specific reviewer miss, harmful recommendation or comparative performance claim.
It is optional for workflow edits and does not replace acceptance on the current task. Report
coverage limits; policy changes and passing contract checks alone do not establish improvement.

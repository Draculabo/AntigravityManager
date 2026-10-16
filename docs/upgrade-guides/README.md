# Upgrade instructions

This reference defines when a change needs user upgrade instructions. Release notes summarize
what changed; an upgrade guide explains actions and recovery for affected users.

## When to write a guide

Write or update the guide in the same change that introduces a user-observable incompatibility:

- Account backup, configuration or durable data that requires migration, conversion or a changed recovery procedure.
- A CLI command, option, configuration key or public API request whose previous use stops working.
- A credential location, authentication flow or installer/update requirement that requires user action.
- A change that prevents safe use of an older release with newly written data.

Internal refactoring with all callers updated needs no guide. A compatible change that requires
no user action can use the existing release notes. Explain that judgment during review when a
changed data or public interface makes the distinction unclear. A guide does not authorize the
underlying migration, credential write, release or deployment.

## Location and content

Use `docs/upgrade-guides/next/<topic>.md` until the target release is known, then move it to
`docs/upgrade-guides/<version>/<topic>.md` and repair incoming links. Keep one guide per affected
user action, updating an existing unreleased guide when the same behavior changes again. Version
directories use `major.minor.patch` with an optional prerelease suffix.

Start with `# Upgrade guide: <user action>` followed by `Target version: next` or the exact directory
version. Provide these sections with concrete instructions:

| Section             | Required content                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Affected users`    | Source versions, platforms, data or settings that require attention; who can upgrade normally.                                         |
| `Required action`   | Ordered actions before and after upgrading, including whether the application must be stopped.                                         |
| `Data and recovery` | Backup ownership, protected data, partial-failure behavior, restoration and readback checks. State explicitly when data is unaffected. |
| `Downgrade`         | Whether an older application can read the resulting data and what must be restored first. State when downgrade is unsupported.         |
| `Verification`      | Observable success and failure indicators, linked checks actually run and any unverified platforms.                                    |

Link the owning implementation or decision and current behavior reference. Distinguish tested
recovery from a proposed procedure. Use synthetic examples and safe paths; keep credentials and
private account data out of guides. If evidence is unavailable, state the gap rather than claim
the migration or downgrade works.

## Validation and review

`pnpm run check:agent-contracts` checks guide placement, version metadata, local links, named pnpm
commands and nonempty sections. Placeholder-only sections fail. Code review determines whether a
guide is required and whether the instructions match actual behavior; format checks cannot make
those judgments. Follow [testing strategy](../testing.md) for the migration, restore, installer or
native evidence required by the underlying change.

# Documentation

Use this index to find the current owner for project behavior. Root-level guides cover rules that
cross feature boundaries; feature behavior and acceptance procedures are grouped by the owning
`src/modules/<feature>/` module.

## Cross-cutting references

- [Architecture](architecture.md): runtime topology, module ownership, dependency direction and
  process boundaries.
- [Development](development.md): contributor setup, repository commands and local Git checks.
- [Testing strategy](testing.md): change-to-evidence mapping and test entry points.
- [Test reliability](test-reliability.md): isolation, completion signals and intermittent failure
  investigation for asynchronous acceptance.
- [Security and data boundaries](security.md): sensitive data, trust boundaries, persistence and
  required evidence for high-risk changes.
- [Failure ownership and recovery](error-handling.md): partial effects, recovery authority and
  truthful user-facing outcomes.
- [Upgrade instructions](upgrade-guides/README.md): when and how to document incompatible changes.

## Feature modules

See the [module documentation index](modules/README.md) for guides grouped by source ownership.

## Historical records

[Ownership cutover audit](ownership-cutover-audit.md) is a dated architecture snapshot, not a
current readiness report. Use [Architecture](architecture.md) for current ownership and
[Testing strategy](testing.md) for current verification requirements.

# Documentation

Use this index to find the current owner for project behavior. Root-level guides cover rules that
cross feature boundaries; feature behavior and acceptance procedures are grouped by the owning
`src/modules/<feature>/` module.

## First contribution

1. Start with [Contributing](../CONTRIBUTING.md) to choose a task and understand the PR workflow.
2. Use the [development quick start](development.md#quick-start) to install and run the desktop app.
3. Find the owner in the [module index](modules/README.md), then read the relevant
   [architecture boundaries](architecture.md) before changing cross-process behavior.
4. Select [contributor checks](testing.md#checks-for-a-contribution) for the affected behavior.

Documentation-only contributions do not require a running app or provider credentials.

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

## Topic guides

The root guides contain shared rules and entry points. Detailed procedures and contracts have
their own owners:

- Development: [build and package](development/build-and-package.md), [Git checks](development/git-checks.md),
  [diagnostics](development/diagnostics.md), [Nix](development/nix.md) and [release tooling](development/release-tooling.md).
- Security: [diagnostic privacy](security/diagnostics.md), [private runtime transport](security/runtime-transport.md)
  and the feature contracts linked from [Security](security.md#topic-guides).
- Testing: [native runtime](testing/native-runtime.md), [diagnostics](testing/diagnostics.md),
  [delivery](testing/delivery.md) and the feature coverage linked from [Testing](testing.md#topic-guides).

Add shared policy to a root guide, feature behavior to its module guide, and execution steps to
the owning procedure. Dated execution results remain in their evidence records; keep active
acceptance requirements and unresolved limits in the current reference.

## Historical records

[Ownership cutover audit](ownership-cutover-audit.md) is a dated architecture snapshot, not a
current readiness report. Use [Architecture](architecture.md) for current ownership and
[Testing strategy](testing.md) for current verification requirements.

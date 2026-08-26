# Persistence Instructions

These instructions supplement the repository root `AGENTS.md` for `src/shared/persistence/`.

## Ownership

- This subtree owns cross-feature database connections, schema primitives, generic validation and persistence infrastructure.
- Feature-specific repositories, migrations, codecs and business policy stay in the owning feature module.
- Do not add a feature dependency to shared persistence.

## Database safety

- Use prepared statements or Drizzle query construction for variable data.
- Validate rows and serialized payloads when reading from SQLite; keep schemas close to the owning data contract.
- Make transaction and commit points explicit for multi-step writes. Do not publish derived state before the durable write succeeds.
- Preserve backup and restore recoverability. A failed restore must not silently leave a partially accepted result.
- Close or dispose owned connections and temporary resources on success, failure and cancellation paths.

## Formats and credentials

- A schema or on-disk payload change requires an explicit migration, compatibility or rejection policy and focused tests for that policy.
- Secrets remain in the OS credential store or existing encrypted helpers. SQLite stores non-secret metadata and references only.
- Never log row bodies or serialized payloads that may contain credentials. Log bounded identifiers and sanitized failure context.

Database schema, durable format, backup/restore semantics and credential-location changes are high risk and require an Agent Note plus the focused evidence in [docs/testing.md](../../../docs/testing.md).

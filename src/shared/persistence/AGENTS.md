# Persistence Instructions

These instructions supplement the repository root `AGENTS.md` for `src/shared/persistence/`.

## Ownership

- This subtree owns cross-feature database connections, schema primitives, generic validation and persistence infrastructure.
- Feature-specific repositories, migrations, codecs and business policy stay in the owning feature module.
- Do not add a feature dependency to shared persistence.

## Database safety

- Build SQLite reads, writes, and data migrations with the Drizzle query builder and typed table definitions.
- Use Drizzle's parameterized `sql` tag only for individual SQLite expressions the query builder cannot represent. Bind values and interpolate typed columns. Keep complete queries and `sql.raw` out of application code.
- Keep historical audit DDL in the audit module's versioned migration files. Use the native driver for SQLite operations such as PRAGMAs, vacuum, and backup. Use the shared SQLite iterator when you need to stream a Drizzle-built query.
- The SQL lint rule applies to application code, scripts, and tests. The [existing SQL inventory](../../../scripts/quality/existing-sql.json) records specific legacy call sites and occurrence counts. Use Drizzle for new reads and writes in these files, and remove inventory entries as you migrate existing calls.
- Validate rows and serialized payloads when reading from SQLite; keep schemas close to the owning data contract.
- Make transaction and commit points explicit for multi-step writes. Do not publish derived state before the durable write succeeds.
- Preserve backup and restore recoverability. A failed restore must not silently leave a partially accepted result.
- Close or dispose owned connections and temporary resources on success, failure and cancellation paths.

## Formats and credentials

- A schema or on-disk payload change requires an explicit migration, compatibility or rejection policy and focused tests for that policy.
- Cloud-account OAuth token JSON is the explicit local SQLite credential exception documented in [docs/security.md](../../../docs/security.md). Other secrets remain in their owning OS credential store or encrypted helper.
- Never log row bodies or serialized payloads that may contain credentials. Log bounded identifiers and sanitized failure context.

Database schema, durable format, backup/restore semantics and credential-location changes are high risk and require an Agent Note plus the focused evidence in [docs/testing.md](../../../docs/testing.md).

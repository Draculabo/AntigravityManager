# Security and Data Boundaries

This document defines the security-sensitive boundaries that repository changes must preserve. Read it before changing preload exposure, IPC, credentials, logging, persistence, proxy authentication, updates or external process execution.

## Trust model

- Electron main, preload and renderer are separate trust zones.
- The renderer receives only APIs explicitly exposed through `contextBridge` in [src/preload.ts](../src/preload.ts).
- IPC/ORPC, HTTP, filesystem, database, process, worker and deserialization inputs are runtime boundaries and require validation before trusted use.
- TypeScript types alone are sufficient only for typed values that never crossed a runtime boundary.

Do not expose general-purpose filesystem, process execution, Electron IPC or credential APIs to the renderer. New preload methods must be narrow, typed and backed by an allowlisted main-process operation.

## Sensitive data

Sensitive data includes access and refresh tokens, API keys, authorization headers, session secrets, credential payloads, account recovery material and any value that can be exchanged for account access.

- Store credentials through existing OS keyring or encrypted-storage helpers.
- Do not store plaintext credentials in SQLite, configuration files, fixtures, snapshots or logs.
- Keep non-secret account metadata and credential references separate from secret payloads.
- Do not copy production credentials into tests, bug reports or Agent Notes.

## Logging and errors

Logging may include operation names, provider names, status codes, sanitized identifiers and bounded diagnostic metadata. It must not include raw authorization values, credential payloads, request bodies containing secrets, or unbounded external responses.

Errors sent through IPC or HTTP must expose information needed by the caller while keeping internal stack traces, secrets and provider-sensitive payloads out of normal user-facing fields. Internal diagnostics may retain a sanitized stack in trusted logs when existing logging policy permits it.

When adding a new sensitive field, update the central masking behavior and its tests before logging objects that may contain that field.

## Persistence

- Use prepared statements or Drizzle query construction for variable data.
- Validate rows and serialized payloads when reading them from storage.
- On-disk format changes require an explicit version, migration or rejection policy.
- Backup and restore paths must preserve transactional safety and must not silently produce partially restored state.
- Credential migration must fail clearly when every usable credential source fails; it must not erase the last recoverable value before replacement succeeds.

Database schema, durable payload and credential-location changes require an Agent Note because they impose compatibility and recovery obligations.

## Proxy and external services

### Google OAuth scopes

Google authorization URLs request `openid` alongside the existing service scopes in the [cloud-account scope definition](../src/modules/cloud-account/oauthScopes.ts). Explicit Agy switches write the same configured scope string to the generic Gemini OAuth cache; Classic and IDE switches do not synchronize that cache. At this file boundary, expiry values greater than `10_000_000_000` are treated as milliseconds and written unchanged; all other values are converted from seconds to milliseconds. This does not normalize stored account data or internal expiry checks. `id_token` remains optional: only `undefined` omits the field, while an explicitly supplied empty string is written unchanged.

The cache scope string describes configured requests, not verified grants for an individual token. Adding a scope does not upgrade existing access or refresh tokens. Accounts missing the grant require a new authorization flow and user consent; refreshing or rewriting the cache alone is not a scope migration. Existing account records and credential files are not rewritten automatically when the application updates.

### External request boundaries

- Treat upstream responses and error payloads as untrusted input.
- Bound retained or emitted bodies, metadata, item counts and timeouts at the point where the complete value is known.
- Do not forward internal credentials or administrative details to downstream clients.
- Enforce authentication and authorization in the operation that performs the protected action, not only in UI visibility or prompt/schema filtering.
- Preserve protocol error semantics without returning raw provider secrets or internal implementation objects.

## Updates and external execution

Installer, updater, shell, subprocess and binary-patching changes are high risk. Validate exact targets and arguments, preserve platform quoting rules, and avoid command construction from untrusted strings. Update sources and artifacts must retain the repository's existing integrity and signing expectations.

## Required evidence

Use [testing.md](testing.md) to select focused tests. Security-sensitive changes normally require:

- the owning behavior test;
- a test demonstrating rejection or sanitization at the actual runtime boundary;
- `npm run type-check` when a public or cross-process type changes;
- platform-specific evidence when behavior depends on the OS keyring, native modules, Electron packaging or installers.

If platform evidence cannot run locally, report it as unverified rather than replacing it with a mock-only claim.

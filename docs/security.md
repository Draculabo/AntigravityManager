# Security and Data Boundaries

This document defines the security-sensitive boundaries that repository changes must preserve. Read it before changing preload exposure, IPC, credentials, logging, persistence, proxy authentication, updates or external process execution.

For partial writes, uncertain outcomes and failed recovery, follow [failure ownership](error-handling.md). The affected feature remains responsible for establishing safe state; diagnostics alone do not establish recovery.

## Trust model

- Electron main, preload and renderer are separate trust zones.
- The renderer receives only APIs explicitly exposed through `contextBridge` in [src/preload.ts](../src/preload.ts).
- IPC/ORPC, HTTP, filesystem, database, process, worker and deserialization inputs are runtime boundaries and require validation before trusted use.
- TypeScript types alone are sufficient only for typed values that never crossed a runtime boundary.

Do not expose general-purpose filesystem, process execution, Electron IPC or credential APIs to the renderer. New preload methods must be narrow, typed and backed by an allowlisted main-process operation.

## Sensitive data

Sensitive data includes access and refresh tokens, API keys, authorization headers, session secrets, credential payloads, account recovery material and any value that can be exchanged for account access.

- Cloud-account OAuth tokens are stored as JSON in the user's local SQLite database. Protect the
  profile directory and its backups with OS account permissions; anyone able to read the database
  can read those tokens.
- Other credential stores retain their existing keyring or encrypted-storage policies.
- Do not put credentials in logs, test fixtures or diagnostic snapshots.
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

## Topic guides

Start with the owner matching the changed boundary. These guides own implementation-specific
contracts and exceptions to the shared rules above.

| Boundary                                                                | Current owner                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Account storage, OAuth sessions, public account views and import/export | [Cloud-account security](modules/cloud-account/security.md)                                  |
| Official-client credentials, snapshots and recovery                     | [Client runtime security](modules/antigravity-runtime/security.md)                           |
| Private RPC, configuration and selected-owner admission                 | [Runtime transport security](security/runtime-transport.md)                                  |
| Reporting consent, diagnostic projections and SDK receipts              | [Diagnostic privacy](security/diagnostics.md)                                                |
| Preload validation, error attachments and updates                       | [Desktop security](modules/app-shell/security.md)                                            |
| Audit/Thought content, coding-tool files and local media                | [Gateway security](modules/proxy-gateway/security.md)                                        |
| Identity-profile management transport                                   | [Identity-profile security](modules/identity-profile/overview.md#account-transport-security) |

Existing section links remain navigation entries for the moved topics below.

| Topic                                                                                           | Current owner                                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| <a id="schema-diagnostics-and-node-reporting"></a>Schema diagnostics and Node reporting         | [Guide](security/diagnostics.md#schema-diagnostics-and-node-reporting)                     |
| <a id="correlated-operation-reports"></a>Correlated operation reports                           | [Guide](security/diagnostics.md#correlated-operation-reports)                              |
| <a id="proxy-traffic-and-thought-persistence"></a>Proxy traffic and thought persistence         | [Guide](modules/proxy-gateway/security.md#proxy-traffic-and-thought-persistence)           |
| <a id="linux-secret-service-collections"></a>Linux Secret Service collections                   | [Guide](modules/antigravity-runtime/security.md#linux-secret-service-collections)          |
| <a id="google-oauth-scopes"></a>Google OAuth scopes                                             | [Guide](modules/antigravity-runtime/security.md#google-oauth-scopes)                       |
| <a id="local-snapshots-and-client-recovery-files"></a>Local snapshots and client recovery files | [Guide](modules/antigravity-runtime/security.md#local-snapshots-and-client-recovery-files) |
| <a id="coding-tool-configuration-files"></a>Coding tool configuration files                     | [Guide](modules/proxy-gateway/security.md#coding-tool-configuration-files)                 |
| <a id="classic-terms-state"></a>Classic terms state                                             | [Guide](modules/antigravity-runtime/security.md#classic-terms-state)                       |

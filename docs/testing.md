# Testing Strategy

Select evidence according to the behavior a change can affect. Focused tests are the normal local default; exhaustive suites and platform matrices belong in CI or an explicitly requested full rehearsal.

## Evidence principles

- A passing command is evidence only for paths it executes.
- Prefer user-visible output, persisted state, protocol output or another stable observable over private call sequences.
- New validation scripts and regression tests must be capable of failing for a representative violation.
- Never weaken assertions, skip checks or narrow coverage solely to make a failure disappear.
- Report only checks that actually ran; report blocked or unavailable evidence separately.

## Change-to-evidence matrix

| Changed surface                       | Minimum local evidence                                                | Add when applicable                                                        |
| ------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Pure utility, mapper or codec         | Owning Vitest file                                                    | Adjacent tests for a shared type or caller contract                        |
| React component or hook               | Owning Testing Library/Vitest file                                    | Focused E2E for navigation, preload or multi-window behavior               |
| Route definition                      | Related component test and `npm run type-check`                       | Focused Playwright flow for user navigation changes                        |
| ORPC schema or handler                | Owning handler/router test and `npm run type-check`                   | Renderer consumer test when the result or error contract changes           |
| Preload bridge                        | `preload-sandbox.test.ts`, affected IPC test and `npm run type-check` | Focused Electron E2E when exposure or lifecycle changes                    |
| Electron main lifecycle               | Owning startup, window, tray or process tests                         | Focused E2E; package when bundled runtime behavior changes                 |
| SQLite repository or codec            | Owning database/persistence tests                                     | Backup, restore, migration or durability tests for format changes          |
| Credential or security behavior       | Credential-store and sensitive-data tests                             | Migration and platform-specific evidence when storage providers change     |
| Proxy request/response mapper         | Owning protocol mapper and streaming tests                            | Real-path parity or controller integration tests                           |
| Gateway controller/service            | Owning integration and endpoint-coverage tests                        | E2E or live-provider evidence only when the external provider path changes |
| Packaging, updater or native artifact | Owning packaging/update tests                                         | `npm run package`, size audit or platform build when artifacts change      |
| Documentation or agent governance     | `npm run check:agent-contracts` and formatting                        | Link/build checks owned by the affected documentation system               |

## Focused commands

Run a specific Vitest file:

```powershell
npm test -- src/tests/unit/<behavior>.test.ts
```

Run tests matching a name:

```powershell
npm test -- -t "<behavior>"
```

Run a focused Playwright file:

```powershell
npm run test:e2e -- src/tests/e2e/<flow>.spec.ts
```

Run static checks when a shared type, import surface, public export or cross-module contract changes:

```powershell
npm run type-check
npm run lint
npm run format
```

## Proxy-gateway coverage

The proxy gateway exposes several compatibility surfaces. Select tests by protocol and behavior rather than running every proxy test automatically:

- Request and response conversion: the owning OpenAI, Anthropic or Gemini mapper tests.
- Streaming changes: streaming mapper/state, malformed-stream and stream-error tests.
- Tool behavior: tool mapper, namespace and custom tool-call tests.
- Model routing: model availability, alias agreement and routing-policy tests.
- Retry, quota and account leasing: the owning policy/service tests.
- Public endpoint changes: endpoint coverage, controller integration and real-path parity tests.
- Durable Responses behavior: response/session store and durability tests.

When a change affects both streaming and non-streaming paths, test both. When it changes externally visible protocol output, prefer exact object or event-sequence assertions over checking individual fields independently.

## Persistence and security coverage

Changes to SQLite, keyring adapters, credential migration, backups or serialized payloads require the owning focused tests and a failure-path test for corrupt, unavailable or unsupported stored data when that boundary can occur at runtime.

Do not add hostile-input tests to same-process values that TypeScript fully constrains. Do add them at JSON, IPC, file, database, process and external API boundaries.

## Full rehearsal

Use the full local approximation when the user requests it, when diagnosing CI, or when a change is genuinely repository-wide:

```powershell
npm run check:ci
npm run test:e2e
```

Packaging and distributable generation are separate evidence. Run `npm run package` or `npm run make` only when build configuration, native dependencies, packaged paths, update behavior or artifacts can be affected.

## Environment-dependent evidence

Some Electron, OS keyring, native-module, live-provider, update and packaging paths depend on platform capabilities or credentials. Record the exact skipped evidence and why. A focused test passing with mocked Electron or keyring modules does not prove the corresponding native integration.

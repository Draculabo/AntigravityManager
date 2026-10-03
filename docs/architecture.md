# Architecture

This document is the current architectural map for Antigravity Manager. Read it before changing process boundaries, IPC, persistence, routing, or the proxy gateway. Decision rationale belongs in [Agent Notes](../.agents/notes/README.md), not here.

## Runtime topology

```plaintext
Renderer (React, TanStack Router and Query)
    |
    | window.electron + typed ORPC client
    v
Preload (contextBridge and MessagePort transport)
    |
    v
Electron Main
    |-- ORPC router composition
    |     `-- feature-owned routers and handlers
    |-- application lifecycle, windows, tray and updates
    |-- SQLite and OS credential stores
    `-- embedded NestJS + Fastify gateway
          `-- OpenAI, Anthropic and Gemini-facing adapters
```

The Electron main process is the trusted application host. The renderer is treated as an untrusted UI process and receives only the APIs exposed by [src/preload.ts](../src/preload.ts). The preload creates the MessagePort transport used by the renderer-side ORPC client in [src/ipc/manager.ts](../src/ipc/manager.ts). Main-process RPC handling is installed by [src/ipc/handler.ts](../src/ipc/handler.ts).

## Process ownership

| Area                       | Owner                                                                                 | Responsibilities                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Main-process bootstrap     | [src/main.ts](../src/main.ts)                                                         | Electron lifecycle, windows, startup configuration, tray, updates, database initialization, gateway startup and shutdown |
| Preload bridge             | [src/preload.ts](../src/preload.ts)                                                   | Minimal context-isolated renderer API and ORPC MessagePort handoff                                                       |
| Renderer bootstrap         | [src/renderer.ts](../src/renderer.ts)                                                 | Renderer observability initialization and React application startup                                                      |
| ORPC composition           | [src/ipc/router.ts](../src/ipc/router.ts)                                             | Global middleware and composition of feature-owned routers                                                               |
| Embedded server bootstrap  | [src/server/main.ts](../src/server/main.ts)                                           | NestJS/Fastify construction, server lifecycle and transport adapters                                                     |
| Server module composition  | [src/server/app.module.ts](../src/server/app.module.ts)                               | Composition of proxy-gateway server modules                                                                              |
| Application routes         | [src/routes](../src/routes)                                                           | File-based route definitions                                                                                             |
| Router construction        | [src/modules/app-shell/routing/routes.ts](../src/modules/app-shell/routing/routes.ts) | TanStack Router instance and history configuration                                                                       |
| Shared database primitives | [src/shared/persistence/database](../src/shared/persistence/database)                 | SQLite connection, schema and generic row validation                                                                     |

## Dependency direction

Dependencies should move from presentation and composition toward owned capabilities:

```plaintext
routes/components -> feature hooks/actions -> feature services/repositories
renderer -> preload contract -> IPC/ORPC -> feature handler/service
main bootstrap -> module composition -> feature lifecycle service
feature persistence -> shared database primitives
server bootstrap -> proxy-gateway server module
```

The following reverse dependencies are not allowed:

- `src/shared` must not import a feature module.
- A feature module must not depend on another feature's private implementation merely to reuse a helper.
- Renderer code must not import Electron main-process, database, filesystem, keyring, or server implementation modules.
- Feature behavior must not be implemented in the root ORPC router or server bootstrap.
- Shared infrastructure must not acquire product behavior that has a clear feature owner.

When a capability genuinely has multiple consumers, expose a narrow shared API or move the capability to `src/shared`. Do not move code pre-emptively based on hypothetical reuse.

`npm run verify:boundaries` derives a runtime import graph from the current Git worktree and reports violations of these rules. `npm run verify:boundaries:enforce` rejects renderer/preload main-process reachability, reverse `shared` dependencies and root IPC imports of feature internals. [src/ipc/router.ts](../src/ipc/router.ts) may compose feature router exports but may not import feature handlers, repositories or services directly.

## Feature ownership

Feature-specific components, hooks, IPC routers, services, persistence and types live under `src/modules/<feature>/`. The current feature owners are:

- `account`: local account snapshots, Antigravity state backup/restore and account UI.
- `antigravity-runtime`: process discovery, startup, switching, client credential storage and runtime patching.
- `app-shell`: window, tray, theme, routing, updates and application-wide UI actions.
- `cloud-account`: cloud authentication, monitoring, quota, import and persistence.
- `config`: application configuration and its IPC/UI surfaces.
- `identity-profile`: identity profile behavior and dialog UI.
- `proxy-gateway`: local HTTP gateway, protocol mapping, model routing and gateway administration.

Generic UI primitives belong in `src/components/ui`; application-wide composition belongs in `src/components/layout` or `src/components/shared`. A component stays in its feature when its language or behavior depends on that feature, even if it is visually reusable.

## Antigravity process operations

The `antigravity-runtime` module owns executable discovery, bounded process observation, context capture and operation coordination. Windows and Linux start the selected executable directly with array arguments and detached, ignored stdio; macOS opens the selected application bundle. Windows GUI launches leave `windowsHide` disabled so the application's initial window can appear. WSL selects native Linux observation for an explicitly configured Linux executable, or Windows observation for a mounted Windows executable; absent explicit configuration, existing Windows discovery remains the default. Ordinary startup does not send an OAuth URI. Process observation requires the application name or a configured executable match; mentioning Antigravity in an unrelated editor's arguments does not identify an application process.

A GUI switch captures the executable, configured arguments and effective user data directory before closing the app. Executable and directory conflicts fail before closing or writing account data. Canonical paths identify symlink aliases; a Linux CLI wrapper is equivalent only when the installation layout and product descriptor identify the same installation. Only the necessary user data directory is recovered from a running process. Injection, identity profile updates, version selection and restart receive the same explicit context without later cache or default-directory fallbacks. The `agy` target skips GUI operations.

One launch command is followed by process confirmation with a six-second deadline. Native process queries use the published read-only `@draculabo/sysinfo-process-enhanced` dependency. Its worker snapshots preserve argv boundaries on Windows, Linux and macOS. The library owns independent caller deadlines and merges overlapping native scans; the Manager adapter validates returned metadata and its consumers select application processes. npm installs the matching prebuilt platform package, and Forge's AutoUnpackNatives plugin unpacks its `.node` binary. Native observation is capped at one second and expired results are discarded; the OS refresh itself cannot be forcibly interrupted. Only WSL observation of Windows applications retains a bounded PowerShell/CIM bridge with a 4.5-second cap. Every probe is capped to the remaining operation deadline. The deadline starts after dispatch; preflight discovery and the renderer's next status refresh add to the visible operation time. Failure reports startup as unconfirmed and never dispatches a second launch. When account data has already been updated, the error explicitly reports partial completion; it does not roll back or report a successful account switch.

The main process reserves the selected target before switch preflight. A global switch owner protects credentials and CLI files shared by targets; another switch reports busy immediately and is never queued. Concurrent starts for one target share the operation; manual start/stop during a reserved switch reports busy immediately. Classic and IDE have independent process-operation state. Internal close/restart runs under the switch reservation, which lasts through startup confirmation. Switch-status diagnostics expose the active owner without queue fields. The feature-owned `proc.getOperation` endpoint exposes only `idle`, `starting`, `stopping` and `switching`. The renderer uses it with local mutation state to disable controls, display loading and surface errors.

Native Windows observation excludes language services with `--clientProcessId`, `--node-ipc` or `--useNodeIpc`, including separated and equals-form arguments. It also walks the full snapshot's parent chain through utility hosts to exclude same-executable descendants of another application candidate, even when they have no known helper arguments. A parent started after its child cannot establish ancestry. Independent roots, different executable paths and explicit user-data-directory instances remain visible to conflict checks. These children reuse the IDE executable without an Electron `--type` and must not count as independent main processes for launch confirmation or shutdown. Shutdown invokes `taskkill /T` for verified main processes; it does not spend the shared deadline closing each language service separately. Switch timing traces distinguish an unconfirmed exit from other close failures, and numeric command exit status remains available in close diagnostics.

Native observation requires readable executable and argument metadata for visible target candidates. An exiting process can briefly retain its name while losing that metadata. Observation retries only this partial-snapshot condition within its existing query deadline and requires a fresh complete snapshot; it never interprets the unreadable row as absence. Persistent unreadability, enumeration errors and deadline expiry remain explicit probe failures.

Native Linux shutdown captures descendants of the verified main processes before sending `SIGTERM` to those main processes. Initial claim and subsequent snapshots compare executable paths and startup timestamps before signalling a captured PID. It allows two seconds for graceful shutdown, then sends `SIGKILL` to captured survivors from leaves upward. Reparented descendants remain tracked; unrelated processes with similar names are excluded. Shutdown succeeds only when the captured tree disappears and a fresh target query confirms no main process remains within the operation deadline. Native Windows `taskkill /T /F` uses `C:\Windows\System32\taskkill.exe` when present and falls back to `taskkill.exe` otherwise. A native Windows command failure requires fresh process observation within the remaining deadline: an already absent main process proceeds to final exit confirmation, while a surviving process or exhausted deadline reports failure. WSL Windows interop retains `/mnt/c/Windows/System32/taskkill.exe` and reports command failures directly. Both use the remaining shutdown deadline rather than the shorter process-query budget and never retry another command.

## Client account storage

Both cloud switches and local snapshot restores use the runtime-owned prepared account writer. Preparation validates a detached credential copy, captures one destination, and checks existing SQLite state before closing the application or updating account state. IDE writes SQLite UnifiedStateSync; Classic version 2 and later write system credentials, while earlier Classic versions write SQLite UnifiedStateSync. CLI writes system credentials and its local session and Google OAuth files. If Classic's version is unavailable, the resolved installation's existing database selects SQLite; otherwise it selects system credentials.

SQLite writes run in one transaction, preserve unrelated OAuth topic rows, replace OAuth and minimal user identity, write or clear the account's enterprise project, and remove obsolete jetski and cached authentication state. Missing project data clears the previous account's project. New installations initialize the database; damaged existing databases fail preflight. Each prepared writer takes one online recovery backup before its first write, including WAL changes, at `state.vscdb.account-switch.backup`. It never injects into the client's `.backup` database. Primary-store write/readback failure reports failure even when a backup exists. Credential-store writes also require matching token readback; explicit CLI switches propagate required file failures. Windows reads and writes the exact generic credential target `gemini:antigravity` through `CredReadW` and `CredWriteW`, using the existing Koffi dependency. Credential reads never construct or replace an entry. Keytar uses a different `service/account` target and cannot implement this contract. Local vault calls and `GetLastError` run on the same thread; returned native allocations are freed after decoding. Snapshot capture and local discovery await credential reads, and required credential writes finish before client-file synchronization and readback.

Local account files retain the version `1.0` snapshot envelope and normalize historical jetski tokens into the same write contract. New files encrypt the whole envelope with the existing Manager master key and use atomic private-file replacement. Historical JSON is read without rewriting it. Native credential snapshots encode tokens into the existing UnifiedStateSync snapshot fields. Snapshot validation and decryption precede shutdown; no current account state supplies missing snapshot credentials or project data.

Windows version discovery reads the executable's PE resource through asynchronous Koffi calls to `version.dll`. Other platforms read installation metadata; macOS binary plists use a bounded `plutil` query. Discovery never starts the application. Version results are cached by executable and metadata file identity; overlapping probes share work, callers have a 2.5-second deadline, and a timed-out native probe retains its slot until completion. Synchronous request construction reads only an already populated cache.

## IPC and validation

Feature modules own their routers and schemas. [src/ipc/router.ts](../src/ipc/router.ts) composes those routers and applies global error handling; it must not become a second service layer.

Validate data at runtime boundaries: IPC/ORPC inputs, persisted data, configuration, external HTTP responses before trusted use, process or worker messages, and filesystem content. Same-process values already constrained by precise TypeScript types do not need duplicate validation.

Errors crossing into the renderer must preserve actionable public information without exposing credentials, raw authorization values, or unnecessary internal state. Feature services own domain error meaning; the global router owns transport-safe conversion.

## Embedded proxy gateway

The proxy page's service control shows an account-risk notice before the first manual start. Only explicit confirmation records the versioned acknowledgement in the renderer profile's local storage and dispatches startup; dismissing the dialog does neither. Later manual starts reuse that acknowledgement, while stop remains available without it. If preference storage is unavailable, confirmation applies to the mounted control and the notice reappears after remounting. Pending start/stop operations disable the control and display loading. This UI notice does not change gateway IPC contracts or application auto-start behavior.

The Electron main process starts and stops the NestJS/Fastify gateway through [src/server/main.ts](../src/server/main.ts). Protocol controllers, mappers, routing, quotas, retries, streaming state and provider adapters belong under `src/modules/proxy-gateway/server` or another proxy-gateway-owned directory.

Protocol-facing behavior is a compatibility surface. Changes to request mapping, streaming event order, tool calls, usage accounting, error responses, model selection or durable response state require the focused tests listed in [testing.md](testing.md) and may require an Agent Note.

The [proxy compatibility reference](proxy-compatibility.md) describes current Responses history, reasoning, tool configuration and explicit-cache contracts.

## Persistence and credentials

Shared SQLite connection and schema utilities live under `src/shared/persistence/database`. Feature-specific repositories and codecs remain with their feature. Persisted rows are untrusted when read and must be narrowed through the owning schema or codec.

Secrets belong in an OS credential store through the existing keyring helpers. SQLite may hold non-secret account metadata and references needed by features, but it must not become a plaintext credential store. Schema, on-disk payload or credential-location changes are high-risk decisions governed by [security.md](security.md).

## Routing and generated files

Route source files live in `src/routes`. TanStack Router generates `src/routeTree.gen.ts`; never edit that file manually. Application router construction remains in `src/modules/app-shell/routing/routes.ts` so route generation and runtime history configuration have separate owners.

## Where new behavior goes

| Goal                                          | Location                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Add feature UI or behavior                    | Owning `src/modules/<feature>` subtree                                 |
| Add a renderer-to-main operation              | Feature IPC schema/router plus typed renderer client usage             |
| Add a gateway endpoint or protocol behavior   | `src/modules/proxy-gateway/server` and the owning protocol module      |
| Add feature persistence                       | Owning feature repository using shared database primitives             |
| Add reusable database infrastructure          | `src/shared/persistence/database`                                      |
| Add a generic UI primitive                    | `src/components/ui`                                                    |
| Add application shell behavior                | `src/modules/app-shell`                                                |
| Add a route                                   | `src/routes`; regenerate the route tree through the existing toolchain |
| Change a cross-cutting architectural decision | Agent Note plus updates to this document and affected contracts        |

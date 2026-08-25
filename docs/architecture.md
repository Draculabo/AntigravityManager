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
- `antigravity-runtime`: process discovery, startup, switching and runtime patching.
- `app-shell`: window, tray, theme, routing, updates and application-wide UI actions.
- `cloud-account`: cloud authentication, monitoring, quota, import and persistence.
- `config`: application configuration and its IPC/UI surfaces.
- `identity-profile`: identity profile behavior and dialog UI.
- `proxy-gateway`: local HTTP gateway, protocol mapping, model routing and gateway administration.

Generic UI primitives belong in `src/components/ui`; application-wide composition belongs in `src/components/layout` or `src/components/shared`. A component stays in its feature when its language or behavior depends on that feature, even if it is visually reusable.

## IPC and validation

Feature modules own their routers and schemas. [src/ipc/router.ts](../src/ipc/router.ts) composes those routers and applies global error handling; it must not become a second service layer.

Validate data at runtime boundaries: IPC/ORPC inputs, persisted data, configuration, external HTTP responses before trusted use, process or worker messages, and filesystem content. Same-process values already constrained by precise TypeScript types do not need duplicate validation.

Errors crossing into the renderer must preserve actionable public information without exposing credentials, raw authorization values, or unnecessary internal state. Feature services own domain error meaning; the global router owns transport-safe conversion.

## Embedded proxy gateway

The Electron main process starts and stops the NestJS/Fastify gateway through [src/server/main.ts](../src/server/main.ts). Protocol controllers, mappers, routing, quotas, retries, streaming state and provider adapters belong under `src/modules/proxy-gateway/server` or another proxy-gateway-owned directory.

Protocol-facing behavior is a compatibility surface. Changes to request mapping, streaming event order, tool calls, usage accounting, error responses, model selection or durable response state require the focused tests listed in [testing.md](testing.md) and may require an Agent Note.

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

# Agent Note: Standalone core process first slice

Status: implemented

## Problem

The proxy gateway and account persistence are hosted in Electron main, so they cannot run without a desktop session. Moving the desktop onto a new process in one step would also move credential and database ownership before the new runtime is proven.

## Decision

The first slice adds an explicitly launched Node core process. It reuses the existing persistence and NestJS gateway, and offers status and shutdown over Fastify on a Unix domain socket or Windows named pipe. The build rejects static Electron imports. Electron continues using its current in-process lifecycle until the client transition is implemented and verified.

OAuth callback delivery and image quota refresh use runtime callbacks. Electron registers its existing UI behavior; a later headless client can register its own flow without loading Electron modules into the core.

## Alternatives considered

- A custom JSON-line socket protocol would duplicate request parsing, response framing and limits already handled by Fastify.
- Immediately switching Electron to the standalone service would mix a large behavior migration with validation of the new process boundary.

## Consequences

The core has a separate lifecycle and a versioned local management route. Startup and shutdown are serialized. The Unix endpoint lives in a private runtime directory; an exclusive recovery guard prevents competing processes from unlinking a newly bound socket. A crashed recovery may leave the guard behind, in which case startup fails closed until the guard is inspected. Desktop and standalone core still use the same profile without a shared ownership lock, so they must not be run together. Native keyring and packaged-runtime behavior still require platform checks.

## Verification

- `npm run build:core` builds the Node entry point and rejects Electron imports.
- Focused unit tests cover startup order, shutdown during startup, exhaustive closure, local management requests and duplicate endpoint ownership. Unix stale-socket recovery has a platform-specific test that does not run on Windows.
- `npm run type-check` and targeted lint pass.

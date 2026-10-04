# Agent Note: Account Proxy Write Boundary

Status: implemented

## Problem

An account proxy URL can contain username and password credentials. The existing repository write logged the raw URL, and its failure path logged and rethrew the database error. Extending proxy writes over core RPC would otherwise carry that disclosure risk into another runtime boundary.

## Decision

The cloud-account adapter owns proxy replacement/removal and account deletion for embedded and remote modes. Core RPC validates bounded account IDs and proxy URLs with the same feature-owned schema used by the renderer route. The proxy URL is accepted only as a write; account views expose a configured flag rather than the stored URL. The repository records only account identity and configured/removed state, and converts write failures into a value-free error. Remote adapter errors never fall back to embedded persistence. Electron continues to select embedded mode.

## Alternatives considered

- Logging a sanitized URL would still risk exposing credentials in unusual URL forms or future format changes.
- Returning the stored URL to support editing would place proxy credentials in the renderer and core read contracts.
- Falling back to local persistence after a remote failure could mutate the wrong account owner.

## Consequences

Database write diagnostics no longer include the database error text at this boundary; callers receive a stable failure message. The user can replace or remove a proxy without revealing its stored value. Account deletion retains its prior repository semantics. The mutation adapter is ready for an explicit future ownership switch, while other account data mutations and authentication operations remain embedded.

## Verification

- Focused repository tests assert that success and failure logs omit a credential-bearing URL and that failure errors are value-free.
- Renderer and real private pipe/socket tests cover embedded and remote proxy replacement/removal, deletion, invalid input rejection, list-view effects and no-fallback behavior.
- Type checking, runtime-boundary enforcement, agent contracts and standalone core build cover the new RPC and Node dependency paths. The native Electron SQLite binary prevents a Node Vitest database integration run in this environment.

# Agent Note: Explicit network listener and client address policy

Status: implemented

## Problem

The proxy previously used the presence of an API key to choose between loopback
and `0.0.0.0`. A saved key therefore changed network exposure, and clearing a key
while the old external listener remained alive could turn that listener into an
anonymous model endpoint. Audit attribution also accepted forwarded addresses
without the same trust decision as request authorization.

## Decision

The persisted `proxy.network` object owns network exposure and client-address
policy. New and old configurations default to loopback. LAN access is explicit
and requires a configured API key. LAN startup prefers a dual-stack IPv6 socket
with `ipv6Only: false`; only platform errors that mean IPv6 is unavailable may
fall back to `0.0.0.0`. Port conflicts and permission failures remain startup
errors.

The HTTP guard, Responses WebSocket authorization and traffic audit resolve the
same client address. They trust forwarding headers only when the TCP peer is in
the configured trusted proxy CIDRs. The chain is evaluated from the service
toward the client, malformed and fully trusted chains fail closed, and all
addresses are normalized before CIDR matching.

Changing the port or LAN listener while the gateway is running is persisted as
`restart-required`; the process does not claim that an old socket was rebound.
Clearing the API key is rejected while the actual running listener is external,
including the interval after a local-only setting was saved but before restart.
IP filters remain dynamically applicable to requests, while the Core management
pipe/socket remains local.

The main Electron window now uses sandboxed, context-isolated, non-Node
integration settings with webviews disabled. New windows are denied by default,
and the ORPC MessagePort handler accepts only the current main window renderer.
The existing narrow preload bridge remains the only renderer-to-main surface.

## Alternatives considered

- Deriving exposure from `api_key` couples credentials to transport scope and
  leaves a dangerous clear-key transition.
- Always binding `0.0.0.0` preserves the old behavior but silently exposes new
  installs.
- Accepting the first `X-Forwarded-For` value lets an untrusted caller influence audit and IP policy.
- Falling back on every listen error hides port conflicts and permission
  failures.

## Consequences

Existing configurations with a key remain local-only until the user enables LAN
access. A LAN toggle or port change while running needs a restart. API-key
rotation remains independent of listener scope. The persisted rule lists are
plaintext configuration and use the existing config backup/recovery policy.

## Verification

The focused D23 matrix passed 55 tests across five files, plus the existing D23
auth and lifecycle matrix (38 tests across seven files). TypeScript type-check
passed. Real LAN/IPv6, proxy-chain traffic and Electron window isolation remain
deferred to the final per-domain real acceptance stage.

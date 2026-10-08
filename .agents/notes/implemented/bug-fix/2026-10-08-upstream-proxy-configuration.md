# Agent Note: Prevent enabled upstream proxies without valid addresses

Status: implemented

## Problem

Sentry issue 7778830976 records Google account enrollment failures in 0.23.0 because an
upstream proxy is enabled with an empty URL. The settings switch permits this state, and
removing the address previously preserves the enabled flag. Detection happens after Google
authorization and is presented as a generic enrollment failure.

## Decision

The configuration module owns a renderer-safe HTTP(S) URL validator and a value-free domain
error. Proxy updates validate the merged configuration inside the existing mutation queue.
Explicit address removal disables the proxy atomically; invalid replacements fail before
persisting or applying settings. Other settings remain writable when a legacy proxy is invalid.

The settings component permits saving an address while disabled and requires a saved valid
address before enabling. Revealed addresses stay in local interaction state. Google authorization
URL creation checks the saved configuration; request-time checks remain to handle changes during
authorization. Desktop and standalone-core transports expose a stable configuration error, with
localized recovery instructions and no proxy URL or credentials.

## Alternatives considered

- Falling back to direct requests violates the user's explicit proxy routing choice.
- Rejecting every settings write for a legacy invalid proxy prevents unrelated settings changes.
- Disabling proxies during load silently mutates routing and obscures the saved configuration.
- UI-only validation leaves private RPC callers and concurrent mutations able to create the bug.

## Consequences

The durable file format and secret locations stay unchanged. Existing invalid configurations
require an explicit correction or disable action. Removing an address now also disables its use.
The private OAuth error enum gains `PROXY_CONFIGURATION_INVALID`; the renderer login category
gains `proxy-configuration-invalid`. Other errors preserve their existing sanitization.

## Verification

Focused tests cover invalid addresses, address normalization, atomic clearing, concurrent
clear/enable writes, persisted configuration, UI recovery and retry, request-time rejection,
and desktop and standalone-core login failures before opening the browser. A negative control
that preserves the enabled flag when clearing the address fails the four clearing/concurrency
regression cases.

The real-socket HTTP test verifies that Google API requests reach the explicitly configured
loopback proxy. The opt-in live check reached Google through a local HTTP proxy and received the
expected 401 for a synthetic invalid token. The isolated Electron settings workspace check covers
navigation, themes and narrow-window layout with synthetic data.

These checks do not establish completed Google authorization, packaged Electron behavior or
platform installer behavior. Type checking and agent-contract checks remain required for the
changed public error contracts and this decision record; unrelated worktree failures must be
reported separately from the focused evidence.

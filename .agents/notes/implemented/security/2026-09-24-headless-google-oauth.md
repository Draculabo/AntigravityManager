# Agent Note: Headless Google OAuth

Status: implemented

## Problem

The existing Google account login uses an Electron callback and renderer delivery path. A standalone Node core needs to complete login without importing Electron or exposing authorization codes and account tokens through the management channel.

## Decision

The Node core opens a temporary `127.0.0.1` callback listener, generates a random one-use state, and supplies its exact redirect URI to the existing Google OAuth URL and token-exchange functions. After a matching callback, the core enrolls the account through a Node-safe service and reloads the running gateway account lease cache. The management channel exposes a session ID, browser authorization URL, bounded status and safe account summary. The CLI prints the URL and polls status. Electron retains its existing browser-opening and tray behavior as a thin adapter over the same enrollment operation. Shutdown blocks new OAuth sessions before awaiting in-flight work, and the core closes the callback listener before releasing its profile lease.

The desktop also preserves the prior manual authorization-code field. A user-pasted code is a bounded, one-time input to the selected account owner while a session is pending; the owner exchanges it using that session's captured client and exact redirect URI. The automatic callback and manual submission share a consumed flag, so only one path can enroll. The renderer does not receive the session ID, callback code, token response or credentials.

## Alternatives considered

- Passing an automatically received authorization code to the CLI or renderer would enlarge the credential-bearing process surface. The manual desktop field is an intentional user input and has a narrow completion route; the owner still performs token exchange and storage.
- Requiring Electron to open the browser would prevent operation on machines without a display server.
- Reimplementing token exchange in a second library would duplicate the project's client selection and provider response handling.
- Forwarding custom OAuth client definitions through the detached child environment would propagate client secrets. The CLI uses the core's default client and does not expose a client-selection flag until custom clients have a secure configuration path.

## Consequences

The browser must run on the same machine as the core for the loopback redirect. Provider-side redirect registration and actual Google consent remain live-provider checks. Account persistence is the login success boundary: a failed gateway cache refresh is logged as a safe warning and does not turn the saved account into a failed login. The running gateway may need a later cache refresh before it can use that account.

Manual completion requires an active browser login session, because the authorization code must match its redirect URI. The one-time code traverses renderer IPC only when the user pastes it. It is validated at the renderer and private management boundaries, is not logged or persisted, and receives only a value-free acceptance response. Remote-owner errors never cause Electron-local exchange. The old fixed-port callback implementation is not restored because it would create a second credential owner; the visible desktop behavior remains browser sign-in, automatic account addition and manual paste fallback.

## Verification

- Loopback tests cover state mismatch, single use, denial and expiry without live credentials.
- Manual completion tests cover exact client/redirect reuse, replay rejection, callback race and remote-owner transport without live credentials.
- Account enrollment tests verify the exact redirect URI and duplicate rejection.
- Management and CLI tests cover bounded typed responses and safe output.
- Shutdown tests reject new and in-flight login starts; cache refresh tests cover success, gateway absence and failure after persistence.

# Agent Note: Node-Safe Cloud Quota Refresh

Status: implemented

## Problem

Manual quota refresh lived in the Electron IPC handler, and post-import hydration dynamically imported that handler. A standalone Node owner could not reuse the operation without loading desktop-only modules.

## Decision

Move the existing quota refresh policy into a cloud-account service. Keep token merge and account status transitions in a second feature-owned service because account switching also uses them. The IPC handler supplies explicit callbacks for the established desktop side effects: tray plus weekly warmup on the primary success path, and weekly warmup only after a successful 401 retry. The post-import task calls the Node-safe service directly. A separate Node-safe warmup runner now schedules the useful post-import warmup without updating the desktop tray.

The operation remains local to the owning process. It is not available through core RPC until a strict result projection and remote account adapter are added.

## Alternatives considered

- Importing the Electron IPC handler from the standalone core would pull in shell, tray and account-switch code.
- Copying the quota refresh algorithm into the core would let token and status behavior drift between runtimes.
- Exposing full account objects through core RPC would transfer tokens and proxy credentials across a new boundary.

## Consequences

Both runtimes can execute the same token, quota, cached-credit, rate-limit and health policy. Post-import completion no longer updates the desktop tray; it schedules warmup when the owning runtime has configured an executor and warmup is enabled. Core ownership still needs a strict quota RPC result projection and explicit adapter routing.

## Verification

Focused service tests cover primary success, 401 retry, cached and uncached rate limits, 403, retryable `invalid_grant` and durable refresh blocking. Existing handler and post-import tests remain in the focused suite. Type, boundary and core build checks validate the Node import path.

# Agent Note: Settings and Gateway Outcome Ownership

Status: implemented

## Problem

A gateway operation can succeed while saving its startup choice fails. Repeating the lifecycle
operation during a save retry can undo the user's action. Independent settings owners can also
commit separately, while a single draft or generic failure hides which changes remain unsaved.
Invalid service settings must not prevent independent desktop preferences from loading.

## Decision

The selected gateway lifecycle owner serializes explicit manual start and stop operations and
reports runtime and persistence outcomes independently. Its save-only retry preserves the
selected startup choice without repeating start or stop. Internal shutdown does not save a
manual stop choice. The page reads actual status separately from saved intent.

Service, desktop and account-alert owners retain independent commit results. The renderer
captures field patches before asynchronous rebasing, keeps failed and newer edits, and retries
only retained changes. Runtime consumers report partial application with safe step and diagnostic
references. The running server owns comparisons for startup-only network, listener, concurrency
and CORS behavior, so later unrelated saves cannot erase pending restart obligations.

Missing or blank service files initialize independent validated defaults and expose writeback
failure separately. Invalid or unreadable files remain untouched and block ordinary replacement.
The missing desktop preference store can use independent defaults when its legacy service seed
is unavailable. Existing desktop files remain strict. Owning mutation queues have finite
admission and explicit close/drain composition. App/Core compatibility 10 includes these contracts.

## Alternatives considered

A UI-only save after a low-level lifecycle call loses selected-owner serialization. Repeating
start or stop on persistence failure changes runtime intent. Whole-draft retries can overwrite
newer edits or repeat already completed independent writes. Replacing malformed configuration
with defaults destroys recovery evidence. Guessing hot application from a successful disk write
hides startup-only consumers. These alternatives are rejected.

## Consequences

Configuration failure can leave the service unavailable while desktop and account features remain
usable. Recovery requires correcting the preserved file or restoring a verified backup, then
retrying its owning read; normal save does not silently repair invalid files. A partial runtime
application remains visible even though the saved snapshot is authoritative for the next start.
Native process and file effects remain separate from renderer presentation. Current contracts
and recovery guidance live in [settings runtime](../../../../docs/modules/proxy-gateway/settings-runtime.md).

## Verification

The implementation was traced in source through typed renderer, selected adapters, Core RPC,
lifecycle/configuration queues, startup containment and shutdown. The user's feature-first
instruction explicitly defers tests, test edits, type checking, lint, builds, formatters, check
scripts, browser acceptance and real profiles. No executable acceptance is claimed for this
snapshot. Native backup recovery, queue pressure, actual routing and rendered feedback still
require the original D22 acceptance evidence. The agent-contract check is also deferred.

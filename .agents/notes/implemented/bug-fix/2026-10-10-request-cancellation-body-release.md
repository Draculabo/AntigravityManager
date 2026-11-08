# Agent Note: Request cancellation releases preparation waiters

Status: implemented

## Problem

Internal generation restored history even for an already cancelled request. Cancellation
while awaiting cold hydration did not settle the caller until SQLite replied. Shared
hydration had no independent subscriber ownership. Explicit cache preparation similarly
retained a full generation request while a shared static cache creation remained pending.
Anthropic Messages did not propagate the HTTP disconnect signal to its generation transport.
Destroying a returned capture Transform left its source HTTP stream alive.

## Decision

Make requester subscriptions own their cancellation. Same-session subscribers share one
hydration job. Cancelling one removes only that subscriber; removing the last subscriber
aborts unissued cold work and detaches the callers from an executing read. The actual SQLite
operation keeps its queue slot until settlement and never receives a forced terminate command.
Cancelled jobs cannot poison later hydration or repopulate the cache. Store lifecycle
cancellation retains its existing generation guards and bounded worker close semantics.

Internal generation checks cancellation before preparation and forwards the signal into
Thought Store subscriptions. A narrow request-operation waiter also allows cancellation
while awaiting shared explicit cache creation without retaining the full generation body.
The shared cache's static candidate and bounded provider operation keep their own lifecycle.
Anthropic Messages owns an HTTP abort scope and forwards its signal into account selection,
normal/fallback generation and recovery. Cancellation exits without another account attempt
or upstream failure penalty. External wire schemas and durable formats remain unchanged.
The returned capture stream owns its source and unpipes/destroys it on close. This preserves
terminal audit completion while ensuring downstream teardown closes the original HTTP stream.

Gemini count actions also forward the HTTP abort signal through service preparation,
account pool/selection waits, retry grace and Axios count transport. The shared count
owner checks cancellation before each new account action, after upstream settlement,
before success effects and before local-estimate fallback. Its request waiter releases
even if a substituted transport ignores abort; the production transport separately owns
aborting Axios. Late counts/failures cannot publish success, commit session affinity or
become a successful estimate for a cancelled request. Failures already observed before
cancellation can have existing retry-policy effects; cancellation does not reverse them.

## Alternatives considered

- Bind a shared hydration to its first request's signal: incorrectly cancels other requesters.
- Race a promise only at the client: ends the client waiter but leaves cold work queued and
  permits late mutation of a cancelled request body.
- Terminate SQLite when a request disconnects: discards unrelated accepted work and persistence.
- Cancel shared static cache creation with one caller: breaks another waiter for the same resource.
- Treat a failed queue admission as request cancellation: hides actual persistence/admission failure.

## Consequences

Requester cancellation is prompt, but active SQL/decode work is not preempted. Cache history
can remain live after individual request bodies are collected. Shared static cache creation
can outlive one request under its existing timeout. RSS does not necessarily fall immediately
when objects become collectible. Deprecated Complete/count endpoints are outside this new
Messages signal contract, except native Gemini count now has the explicit signal chain
described above. File expansion and synchronous conversion are not made preemptible.

## Verification

Focused tests reproduce cancellation before/during history restoration and shared cache
preparation. They cover independent subscribers, last-subscriber cancellation, queued removal,
later reload, active-slot ownership and cancellation during Anthropic first-event preflight.
Existing controller, signature recovery, retry and context-cache tests retain compatibility.
Old retry wire tests use valid typed generation fixtures rather than casting missing contents.

An isolated native HTTP fixture runs production abort-scope, GeminiClient, Axios and SQLite
Worker code with a loopback upstream. Twelve clients disconnect while cold/transport work is
pending; all handlers and upstream connections settle, no new request follows cancellation,
and a subsequent successful request completes. Weak references verify completed/cancelled
handler bodies become collectible. Measurements distinguish waiting bodies, retained cache
and RSS. This fixture does not establish live-provider or packaged Electron behavior.
The fixture also cancels a real downstream SSE after its first frame and verifies that
the original upstream connection closes. A source-teardown regression first fails with an
alive source and passes when capture-stream close owns source destruction.

Current behavior is documented in [diagnostic retention](../../../../docs/modules/proxy-gateway/diagnostic-retention.md).

The count follow-up first fails five controlled pre-abort/late-result/HTTP-close cases,
then checks pending account selection and actual Axios signal forwarding. Deferred
promises establish dispatch/cancellation ordering; no real upstream or account is used.
It does not extend the earlier loopback/native acceptance to count-specific socket or
installed-client behavior.

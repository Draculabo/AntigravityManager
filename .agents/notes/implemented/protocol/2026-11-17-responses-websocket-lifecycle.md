# Agent Note: Responses WebSocket history and audit lifecycle

Status: implemented

## Problem

Live WebSocket acceptance found that completion did not save a retrievable response,
fresh connections required the model before cursor admission, and generation frames
bypassed the HTTP audit lifecycle. A successful socket reply therefore lacked the
history and physical-attempt evidence available on the HTTP surface.

## Decision

Reuse the HTTP Responses completion writer before delivering a stored completion.
A fresh connection may omit its model when presenting a cursor, and the existing
history owner validates the caller before restoring its transcript and effective
configuration. The connection retains that restored transcript for subsequent
appends. Explicit `store: false` continues to keep the response transient.

The socket message runs inside its existing thought context and receives a new
audit parent. Bounded redacted SSE capture and the physical-attempt owner use that
same invocation context. Completion, provider failure, deadline and disconnect
each finalize the parent once. Audit capture ends before the thought lease releases.
Payload finalization has the same bounded wait as HTTP audit capture. A slow
capture marks the diagnostic payload partial and releases the socket message.

WebSocket phase timers use the existing generation deadline owner. Initial wait,
activity silence and the single transition interval use 180, 120 and 180 seconds.
Each timer is capped by the remaining total request budget. Only actual response
content renews activity. A timeout preserves a failure event and audit outcome.
The independent generation budget defaults to 270 seconds and still bounds a thinking-only response.

The [caller ownership decision](../security/2026-10-17-responses-history-tenant-ownership.md)
continues to own credential identity and durable decoding. The
[total deadline decision](../bug-fix/2026-11-05-generation-total-deadline.md)
continues to bound preparation, retries and response delivery.

## Alternatives considered

- A separate WebSocket history store would duplicate ownership and recovery logic.
- Recording only the upgrade handshake would lose individual frame attempts.
- Extending the total deadline during thinking would violate its existing contract.
- Emitting an unconditional completion after a stream error would
  publish a successful result for a failed generation.

## Consequences

Saved WebSocket completions become retrievable and usable by the same caller after
reconnection. They use the existing store format and retention limits. Removing
this change stops new socket publication while existing records remain compatible
with the HTTP history owner. Audit capture follows the existing local settings,
redaction and storage budgets. The phase policy applies to upstream SSE generation over HTTP and WebSocket.

## Verification

The real socket regression fails before the fix because the first completed reply
is absent from the store. It covers reconnecting without a model and a further
append, preserving the initial history and transient continuation behavior.
The audit socket tests verify distinct parents, physical-send association,
redacted output, failed terminal frames, cancellation and deadline cleanup.
Timer tests verify transition recovery, total-budget bounds and disposal.

The Windows live check uses a rebuilt Core and Sonnet 4.6. Separate authenticated
connections restore the saved cursor without resending the model and recall the
initial fixture value. Both messages have independent audit records and one
successful upstream attempt each. The test deletes its retained reply, confirms
the HTTP not-found response and shuts down its Core owner.

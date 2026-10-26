# Agent Note: Bound SSE output backlog and unfinished shadow events

Status: implemented

## Problem

The Observable SSE writer ignored slow-consumer pressure and buffered about 126 MiB on one
paused local HTTP response. A synchronous producer also continued after excessive backlog.
The incremental audit redactor applied its event budget only after a line ended, permitting
an oversized unterminated line and repeatedly scanning accumulated text.

## Decision

Bound each non-cooperative Observable response's pending socket bytes plus incoming UTF-8 chunk to 16 MiB. The writer
owns its RxJS Subscriber before subscribing and installs close handling first, allowing
synchronous overflow to unsubscribe immediately. Overflow logs fixed numerical diagnostics,
records partial audit completion and destroys the socket without appending success or another
error frame to the full buffer. Error frames use the same budget. Cumulative output remains
unlimited by this pending-byte policy when the consumer drains.
Readable-backed production adapters now use the separately owned
[flow-capable output decision](2026-10-11-sse-producer-backpressure.md); this guard remains
the fallback for plain Observable producers.

Enforce the existing audit event budget during unfinished-line accumulation. Scan only new
text and track retained bytes separately. Preserve fragmented UTF-8 and CRLF framing. Drop
the entire oversized shadow event, emit one fixed omission marker and discard remaining
fragments until its boundary. Resume valid later events. This keeps uncertain credential
fragments out of diagnostics while leaving the original forwarding stream separate.

## Alternatives considered

- Ignore write pressure: permits growth proportional to total output for a paused reader.
- Add an unbounded intermediate drain queue: moves the memory problem rather than solving it.
- Pretend an Observable can pause: the current protocol producer contract exposes no such control.
- Echo conservatively masked oversized fragments: incomplete credentials can span fragments.
- Reduce all audit events to a small new budget: changes existing body-size compatibility beyond
  the demonstrated unfinished-line defect.

## Consequences

This is overload termination, not full producer backpressure. A single output chunk above
16 MiB fails on the plain-Observable path even for an otherwise fast consumer; this boundary can
affect unusually large image/tool events. Per-response pending limits do not cap aggregate
process RSS or already allocated caller chunks. The 100 MiB shadow budget can still retain
a large valid event. Incomplete diagnostics use the existing partial/error metadata; clients
must recognize truncated transport rather than infer success. No automatic retry is added.

## Verification

The paused loopback HTTP fixture fails before the fix and passes with bounded output and
producer teardown. A synchronous-producer regression checks immediate stop and single audit
completion. A 256 MiB long stream verifies complete byte/hash equality and post-GC retained
heap. An oversized unterminated shadow test fails before the fix; framing tests cover every
two-part UTF-8/CRLF split, credential-fragment omission and recovery on later events.
Existing audit, controller and internal client tests cover adjacent behavior. Measurements
do not establish live-provider, Electron packaging or days-long soak performance.

Current behavior is documented in [diagnostic retention](../../../../docs/modules/proxy-gateway/diagnostic-retention.md).

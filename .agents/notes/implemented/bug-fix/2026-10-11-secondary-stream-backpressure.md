# Agent Note: Secondary stream backpressure and large-event decoding

Status: implemented

## Problem

Slow-socket tests showed that synthetic streams eagerly emitted all frames and the HTTP
Responses session wrapper discarded the Readable flow capability. Responses WebSockets
ignored send completion, retained unbounded queued generations and did not cancel request
admission on disconnect. Large fragmented upstream lines were repeatedly flattened and scanned.

## Decision

Preserve one explicit producer owner through the HTTP Responses wrapper. Synthetic protocol
generation remains in an OpenAI-owned module and yields existing frames through a lazy
single-consumer frame iterator without lookahead. Responses mapping and finalization also use
single-use iterators. Stop advancing immediately after the consumer pauses, resume mapping before
the next upstream chunk, and queue finalization without retaining the decoded event scope.
Cancellation closes suspended iterators and removes adapter listeners. This changes scheduling
without changing wire content or event order.

Use a Responses-owned WebSocket output queue. One complete JSON text event is sent at a time;
the send callback releases its reservation. Share conservative output credits with HTTP SSE,
retain per-connection bounds and terminate the overflowing connection. Carry its AbortSignal
through the existing operations factory and release late Readable results. Bound incoming
request count/bytes before enqueue and match the existing model JSON body frame limit.

Give the live and synthetic Responses producers a synchronous, single-frame serialization
capability. WebSocket takes the already serialized JSON and completed mapper output instead
of parsing SSE and serializing the same event again. Observable wrappers do not inherit the
capability, since they can alter output. Clear the current frame on cancellation and completion.
Queue one encoded Buffer per message and reuse it for sending; retain the conservative string
and Buffer reservation because a paused producer can still hold the SSE frame.

Use fragment-based line assembly in streaming adapters, with a conservative unfinished-line
estimate. Charge before retaining and fail explicitly through each protocol's existing error
path. Do not infer successful completion, silently omit output or automatically retry.

The [current reference](../../../../docs/modules/proxy-gateway/diagnostic-retention.md#sse-output-pressure-and-shadow-framing)
owns the numerical limits and failure behavior.

## Alternatives considered

Splitting one WebSocket event into separate JSON messages would change the protocol. The
queue therefore retains whole messages until locally sent. An acknowledgement from `ws` is
not proof that a client processed the message.

Raising buffer limits would postpone failure without propagating pressure.

Retaining array-returning mapper methods alongside lazy methods would leave an eager internal
path and duplicate the contract. All mapper consumers now drain or close the same iterator API.
Removing repeated full-text terminal fields would reduce allocations but break the Responses
wire contract; those frames remain separately serialized on demand.

Forwarding raw JSON from every source would change normalization of values such as `1e999`
and `-0`, and bypass the current event validation boundary. Only exact frames captured from
the owning mapper producers avoid that boundary. A content-keyed cache would retain large
strings across requests; producer ownership and a single current frame avoid that lifetime.

## Consequences

Physical memory
remains larger than reservations: input strings, JSON parse, mapper finalization and receiving
clients allocate separately. The 32 MiB native fixture improves fragmented-line processing
time substantially but only modestly improves OS peak memory. Frame demand prevents concurrent
queued finalization strings; it does not guarantee lower OS RSS during fast consumption. The
fast native fixture shows a smaller sampled heap peak but a larger OS high-water mark. A
separate server-only slow WebSocket fixture reduces event serialization from 18 to 9 and
reparsing from 9 to 0 for both live mapping and synthetic output. Its 32 MiB text cases reduce
OS peak RSS by about 41% and 39% respectively. These are individual workload measurements,
not a process-memory ceiling. Unknown sources still require JSON normalization. Unary
collection cleanup and incremental decoding follow the
[unary ownership decision](2026-10-11-unary-stream-lifecycle.md); total aggregation budgets
remain follow-up scope. No durable schema or credential behavior changes.

## Verification

Regression tests exercise production fallback generation, the HTTP session wrapper, all four
protocols' oversized unfinished lines, WebSocket callback pressure, late-result disconnect,
mixed HTTP/WebSocket output budgets and timeout cleanup. Native loopback acceptance checks
whole-message hashes, synthetic content/terminal frames, queue overflow, disconnect release
and real send timeout. Frame-demand regression tests count serialized and received event types
at every pause, check tool/reasoning completion, suspended-input failure and cancelled factory
work. Native slow HTTP/WebSocket clients verify all nine events and all five required copies
of a 32 MiB Unicode text, including live mapping with a same-event finish reason. The native
mapped-budget regression fails before the change and completes after it. Separate native 8/16/32 MiB decoder fixtures preserve before/after
measurements. These checks use synthetic data and do not establish live-provider or packaged
Electron behavior. No commit, account access or external provider request is part of this batch.

Serialization regression tests cover exact event counts, Unicode and escaped text, unknown
fragmented/multiline sources, modified Observable wrappers, cancellation, tool continuation
history and Buffer reuse. Separate native WebSocket client/server processes preserve all nine
events and five full-text hashes before and after the optimization, with identical stalled
output credits and zero retained credits after completion.

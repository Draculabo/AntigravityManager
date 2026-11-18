# Agent Note: One Generation Execution Deadline

Status: implemented

## Problem

Ordinary account waiting and input-limit/thinking recovery each had partial deadlines,
but every endpoint could receive a fresh Axios timeout. Explicit cache creation and
cache invalidation also preceded another full generation timeout. Preparation or account
selection that did not settle could hold the caller indefinitely. Paused output must not
pause the business deadline.

## Decision

Main HTTP Chat/Responses, Messages and native Gemini generation controllers create a
monotonic deadline before file/history preparation. Direct generation service invocations
create their own owner. Both use `generation_timeout`, whose default is 270 seconds.
Non-generation transport and lease operations retain `request_timeout`. A derived AbortSignal
identifies the owner in a WeakMap. Nested internal generation reuses that signal rather than
starting another owner; direct internal generation creates an owner when necessary.
Cancellation wrappers inherit the same owner, so a thinking continuation cannot acquire a
fresh deadline or replay counter. No ambient AsyncLocalStorage or persistent state is added.

The owner spans service preparation, account waits and retries, physical sends, cache/session/
thinking recovery and returned output. A typed `GenerationDeadlineExceededError` maps to
504, remains terminal at protocol recovery and does not penalize an account. Existing
cancellation helpers preserve this reason while retaining client AbortError semantics.
Late success cannot commit account affinity or start generation after a cancelled selection.
Image permits release on abort, including late selection and transport handoff.

Each physical internal-generation timeout is recomputed immediately before attempt admission
from the lesser of configured/operation timeout and remaining budget. Session/thinking
admission uses the same monotonic deadline. Coalesced explicit cache creation has its own
bounded signal and at most the initiating waiter's remaining budget; cancelling one waiter
does not cancel peers. A remote cache creation may have an unknown outcome after cancellation.
No replay promises exactly-once billing or tool execution.

The owner retains a returned Observable or Readable until complete/error/close/unsubscribe.
Observable forwarding preserves FlowControlledSseStream and registered pause/resume capability.
Heartbeat activity and paused output do not extend the timer. Unconsumed streams are destroyed
on disconnect. Timers/listeners are removed at terminal cleanup. Physical stream audit uses
the deadline reason instead of labelling an owner timeout as a client disconnect.

## Alternatives considered

- Only reducing Axios timeout misses account/hydration/preparation waits and paused streams.
- Restarting a timer at each fallback permits cumulative work beyond the configured budget.
- Cancelling shared cache creation when one waiter leaves breaks other subscribers.
- A global mutable deadline or deep feature import would mix concurrent requests and owners.
- Reinterpreting a serialized 120-second default as user intent cannot distinguish it from a
  custom cap. The independent generation field preserves operator control without rewriting
  maintenance or account-lease limits. A fixed unconfigurable 270-second limit was rejected.

## Consequences

Requests that formerly survived several independent timeouts can now fail earlier with 504.
The approved defaults give generation a separate deadline and enable bounded thinking recovery. The [upgrade guide](../../../../docs/upgrade-guides/next/generation-timeout-policy.md)
explains custom cap migration, the explicit recovery opt-out and downgrade limits.
Successful partial stream output is not replayed. Cleanup aborts transport; SQLite and other
independently owned work retain their existing cancellation/queue contracts. The deadline
starts at the main HTTP controller boundary or direct generation service entry. Responses
session saving consumes that same signal; a durable write admitted before cancellation may
still finish under its persistence owner, so a timed-out caller does not prove absence of
a saved response. Responses WebSocket starts a per-message budget at dispatch, before
protocol admission. Timeout prevents late admission from publishing transcript state and
releases active output. The socket's bounded message queue and write watchdog still own
queue residence and local acknowledgement delivery. Legacy completion dispatch retains
the owner through streaming. Image generation/edit dispatch creates an owner shared with
its native Gemini protocol fallback. HTTP body/multipart parsing before generation
dispatch retains its transport owner.

The execution signal also identifies one project recovery allowance in a WeakSet shared
by protocol services and the image adapter. Consuming it for body removal or a protocol
handoff prevents another project recovery in the same request. The service requires an
actual submitted project; the adapter accepts only the known license rejection or an
already matched structured consumer denial. Unknown resource text and unrelated statuses
retain their original failure. This keeps R5's recovery count aligned with R4's deadline.

The generation owner also holds the large-body replay count. Transport admission increments
it before audit or HTTP dispatch. After three admitted sends, a current body of at least 4 MiB
of serialized UTF-8 JSON stops with a local 503. An account or endpoint switch, aggregate
fallback, or recovery shares the same count. Smaller current bodies retain retry eligibility.
Shared cache creation and scheduled warmup keep their independent ownership. Automatic
redirects are disabled for large scoped generation sends to prevent implicit body replay.

Attempt-local debug timings use the native request finish and response events, followed by
validated usable output. They retain only elapsed durations and audit identifiers. These
observations are independent of the request deadline and the existing first-byte headers.

For native Gemini streams, an expired deadline before response headers is an HTTP
504 with the existing JSON `DEADLINE_EXCEEDED` envelope. Gemini CLI 0.68.0 exposes
HTTP 504 and ignores an SSE error object in its JSON output. The Gemini controller
chooses the envelope and the SSE writer checks whether headers were committed.
After that boundary, the writer preserves the streamed response and its existing
error terminal. See the [public stream error contract](../../../../docs/modules/proxy-gateway/stream-tool-compatibility.md#public-stream-error-messages).

## Verification

Checks exercise all four service surfaces with stalled account selection and established
paused output; direct transport checks cumulative endpoint and cache/retry timeouts. A real
loopback HTTP fixture verifies the remaining second-attempt timeout and cancelled connection.
Owner tests cover nested reuse, timer/listener cleanup, disconnect and flow control; policy
checks cover late/admitted image permit release. Neighboring recovery, protocol, account and
stream/error checks retain their original behavior. Deferred adapter checks exercise image
fallback after 600 ms within the original one-second budget and suppress late success.
The loopback Gemini controller checks cover both sides of the response-header
boundary. An installed Gemini CLI 0.68.0 request with a live upstream confirmed
the pre-header 504 and one closed upstream attempt. CLI error rendering after
response headers and platform scheduling pressure remain gaps.

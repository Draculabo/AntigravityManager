# Streaming usage and tool generation compatibility

This reference describes OpenAI Chat usage placement and tool-call generation behavior in
the OpenAI Chat, Responses and Anthropic compatibility adapters.

For media admission and signed history restoration, see
[inline media and thought history](inline-media-and-thought-history.md).

## Streaming liveness and backpressure

OpenAI Chat emits SSE comment heartbeats every 3 seconds, Responses every 15 seconds,
and Anthropic emits an `event: ping` frame with `{"type":"ping"}` after each
20-second upstream idle interval. The Anthropic first-event gate waits for a
business event and discards pings during preflight. Downstream backpressure
pauses the upstream and suppresses heartbeat generation. Draining resumes normal
delivery without replaying missed heartbeats. Anthropic's first-event wrapper carries
the same pause state into its mapper.

Anthropic Messages uses the shared
[generation deadline and output windows](compatibility.md#account-scheduling-and-stream-completion).
Heartbeats and usage-only frames do not refresh those windows or count as successful
output. Raw upstream data reschedules the next downstream ping. Cancellation clears
timers and pending output, and a later drain cannot resume a closed stream.

## Public stream error messages

Generation SSE failures in Chat, Responses, Anthropic and Gemini use the
[public message redaction and byte-limit policy](compatibility.md#public-http-error-messages).
Safe tool names and reasons remain readable; arbitrary upstream error details
are not copied into the terminal. The existing protocol envelopes remain:

| Adapter   | Failure terminal                                                                   |
| --------- | ---------------------------------------------------------------------------------- |
| Chat      | An `error` object with a validated provider code/type or gateway fallback          |
| Responses | `response.failed` with `response.error.code/message` and observed usage            |
| Anthropic | `event: error` with status-based `error.type`; gateway fallback `api_error`        |
| Gemini    | An `error` object retaining validated provider code/status or gateway 502 fallback |

Earlier partial output remains delivered. The failure does not emit a normal
completion marker, retry generation or mark the account successful. The SSE
writer's terminal-exception fallback also projects its message while retaining
the original cause for the owning diagnostic completion.

If the Gemini generation deadline expires before response headers are sent,
the gateway returns HTTP 504 with a JSON `DEADLINE_EXCEEDED` error. Once headers
are sent, the gateway preserves the HTTP status and sends the error in the SSE stream.

Gemini retains data fragments until the existing event parser produces a complete
payload. It inspects that payload before emitting a normalized SSE data event,
including multiline, CRLF, adjacent-record and supported EOF-tail input. This
prevents an error prefix from reaching the client before its final fragment can
be classified. Valid payload text, SSE field values and comments are retained;
chunk boundaries and line endings are not a byte-for-byte passthrough contract.
Invalid JSON fails explicitly instead of exposing its raw text. An error in an
EOF tail without a final blank line retains the same validated code and status
as a complete event.

Responses normal upstream EOF/close allows suspended mapping iterators to drain
before finalization. Premature close still fails, and EOF without a supported
finish reason remains a failed response after draining. Output backpressure and
cancellation retain their existing resource owners.

Provider errors use the same bounded machine-field projection as HTTP errors.
Responses retains its `response.error.code/message` shape, and WebSocket forwards
the same failed response events. Anthropic closes an active content block without
committing a pending signature before emitting the error; it sends no successful
message terminal afterward.

## Partial-output interruption

After valid visible text or a complete tool call, Chat, Anthropic and native Gemini
close a transport interruption with a protocol terminal sequence. Eligible causes
are recognized upstream network/transfer failures, stream idle expiry and EOF or
premature close without a finish reason. Normal EOF validates any buffered UTF-8
and SSE tail before applying this rule.

| Adapter   | Text interruption                                              | Existing complete tool call     |
| --------- | -------------------------------------------------------------- | ------------------------------- |
| Chat      | `finish_reason: length`, then `[DONE]`                         | `tool_calls`, then `[DONE]`     |
| Anthropic | Close the active block, emit `max_tokens`, then `message_stop` | `tool_use`, then `message_stop` |
| Gemini    | `MAX_TOKENS`                                                   | `STOP`                          |
| Responses | `response.failed` containing observed partial output           | `response.failed`               |

Gemini adds a fixed `finishMessage` and `gatewayInterrupted: true` to the generated
terminal candidate. The gateway preserves emitted model text, tool names and
arguments. It does not repair Markdown or append warning text to the answer.
Termination occurs once. Previously observed usage remains available, but an
interrupted connection cannot provide a complete final usage total.

Thinking alone, signatures, whitespace, inline media and ambiguous multiple
candidates do not authorize this completion. Provider error events, invalid
protocol data, signature conflicts, caller cancellation and the request's total
deadline keep their existing error ownership. Image generation retains its clean
upstream-end requirement. An already emitted terminal reason is not replaced.

The generated terminal sequence preserves client compatibility while the physical
attempt remains interrupted. It does not commit account/model success, retry
generation or persist a completed Responses turn. The adapters log the interruption
independently of the client-facing finish reason.

## Empty output and bounded thinking continuation

The unary and SSE boundaries reject malformed generation containers, parts and
interpreted usage counts. Error envelopes take precedence over candidate data.
A normal `STOP` must accompany usable text, a tool call or inline media; signatures,
usage and whitespace alone do not establish an answer. Explicit refusal,
`MAX_TOKENS` and malformed-tool semantics remain distinct. Anthropic does not
fabricate a period or token usage to make an empty answer appear successful.

`experimental.thinking_only_recovery` is an optional proxy configuration field.
Omitted or true enables continuation; explicit false disables it. Only a single primary candidate
with real thought, normal `STOP` and no visible text, media, tool call, refusal or
error qualifies. Multicandidate streams and interrupted streams cannot qualify.

The gateway clones the original request and adds one continuation cue, `继续。` when
the latest user text contains Han characters and `Continue.` otherwise. It uses a
new child request ID with the same account, model, thinking configuration, tools, endpoint, proxy and header
snapshot. It reapplies signature wire encoding without replaying newly captured
thought. This request is temporary and does not write a fabricated assistant turn.
If the final message already has the user role, the cue becomes an additional text part;
otherwise it becomes a new user message. This preserves Gemini role alternation and any
existing tool-result parts. The failed attempt's thought is not appended to the request.
Continuation has one physical send, no endpoint/account/signature/session recovery
chain, and uses the shared remaining request deadline and retained-output budget.
If the optional recovery snapshot cannot obtain its memory reservation, the original request
still runs without continuation. The provider must actually return an empty result before
an empty-generation error is reported.

The first eligible finish and usage are withheld until the continuation. Real
second-attempt output flows through the existing mapper with continuous response
identity and event sequence. Failure or another empty result terminates explicitly;
there is no task-ready fallback. Latest usage snapshots are added once across the
two attempts, with Interactions aliases normalized. Unknown operands remain absent
in the combined metadata, and the first attempt's usage is not presented as the
combined total. Existing protocol-required usage defaults remain adapter-owned.
The recovery wrapper preserves SSE comments, event IDs, event names, retry fields and
framing. Data rewrites retain those fields. Once visible output disqualifies recovery,
ordinary progress usage is forwarded. Thought-only progress usage remains withheld until
its terminal result is known.

Each physical attempt keeps its own audit entry. Empty or incomplete output and
embedded errors have a failed generation outcome while retaining the actual HTTP
status, including HTTP 200. A successful continuation does not rewrite the first
attempt as successful. Cancellation destroys the active stream, suppresses further
sends and retains pending-request memory credit until the operation settles.

## Unsupported upstream terminal reasons

The gateway recognizes `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION` and
`MALFORMED_FUNCTION_CALL` using its existing terminal semantics. Other nonempty
string finish reasons fail explicitly, including when another candidate has a
recognized reason. They do not become `stop`, trigger another account or start
a generation fallback. Direct responses and first-event Anthropic failures use
HTTP 502; already delivered streams use their protocol error terminal instead.

Earlier partial output remains delivered, and a later `STOP` cannot replace the
failure. Failed Responses are excluded from completed history. Observed usage on
a failed Responses event remains diagnostic usage; Chat does not fabricate a
successful `include_usage` trailer after that failure. Supported terminal states
retain their existing usage and refusal contracts.

Public errors use a fixed message. The internal typed failure retains up to 256
UTF-16 code units of the original reason and a truncation flag. Enabled upstream
audit capture retains the provider frame under its existing privacy and capacity
limits.

## OpenAI Chat usage

Omitted, null or empty `stream_options`, and `include_usage: false`, retain the existing
finish-chunk usage behavior. They do not suppress gateway accounting or Traffic Monitor
statistics. A nonboolean `include_usage` is rejected before account leasing and upstream
execution.

With `stream_options: { "include_usage": true }`, ordinary completion chunks contain
`usage: null`. After the finish chunk, the gateway keeps reading upstream usage trailers.
On clean completion it emits one final completion chunk with `choices: []` and the latest
available usage, followed by `[DONE]`. No independent statistics block is fabricated when
usage is absent, including the unary-to-stream fallback path. Eligible partial-output
interruption uses the latest observed usage with its truncation terminal. Cancelled
streams do not promise final usage. Existing request timeout and stream idle limits still apply.

Responses and Anthropic retain their own usage contracts. This option changes only the
OpenAI Chat compatibility surface.

## Reasoning usage metadata

Chat, Responses and the internal Anthropic usage mappers retain the precedence of `total_thought_tokens`,
`totalThoughtTokens`, then `thoughtsTokenCount`, including an explicit zero. When all
three are absent, their adapters sum valid `THINKING` and `REASONING` entries in
`candidatesTokensDetails`, case-insensitively. Malformed entries do not contribute.
Responses narrows and preserves the array before mapping streamed usage.

Reasoning counts supplement the existing protocol accounting: legacy output totals
are not increased, Interactions output keeps its existing thought/tool accounting, and
Anthropic retains its own output-token contract. Its public unary response retains the
existing usage projection without a reasoning field; its SSE usage retains the existing
`reasoning_tokens` extension. Usage placement and termination are
independent of this fallback. Native Gemini metadata passthrough is unchanged.

## Tool generation failures

Gemini `MALFORMED_FUNCTION_CALL` describes model output that could not form a tool call.
It does not establish that a client attempted and failed to execute a tool. The adapters
retain preceding text and valid calls, add an ordinary assistant text block or delta with
an explicit failure explanation, and terminate normally:

| Surface     | Termination                                                    |
| ----------- | -------------------------------------------------------------- |
| OpenAI Chat | `tool_calls` when valid calls were emitted; otherwise `stop`   |
| Anthropic   | `tool_use` when valid calls were emitted; otherwise `end_turn` |
| Responses   | `response.completed`, with completed output items              |

The upstream finish reason contains no trusted failed-tool name. The explanation states
that the upstream did not identify that tool; it never blames a preceding valid call.
This signal alone does not trigger account, endpoint or whole-request retries. Existing
transport and quota retry policies remain independently owned.

The upstream audit attempt records a `MALFORMED_FUNCTION_CALL` diagnostic for unary and
SSE responses while retaining the successful HTTP/transport completion state. Diagnostic
body capture uses the existing sanitizer. A later transport error keeps its transport
error outcome and takes precedence in the attempt error field.

## Tool passthrough

Ordinary tool names and argument objects are preserved across unary, streaming and
unary-to-stream fallback responses. The gateway does not substitute shell tool aliases,
rename `cmd`, `code` or `input` to `command`, add descriptions or metadata, or fabricate
placeholder commands and workflow scripts. An ordinary function named `shell` uses the
Responses `function_call` lifecycle rather than becoming a custom tool by name alone.

The matching client declaration determines whether an OpenAI tool is custom. Chat emits
`type: custom` with a `custom` payload, while Responses emits `custom_tool_call` and its
input events. For a declared custom tool, the gateway unwraps the upstream string `input`
field without changing its content. If the upstream returns an argument object without a
string `input`, the gateway forwards the whole object as JSON text. This preserves its
fields for the tool to handle. Ordinary functions named `apply_patch` retain their
function arguments. Namespace mapping and explicit built-in tool handling remain in their
existing protocol adapters.

The gateway does not repair or preflight patch syntax. The tool executor reports any patch
failure through its own result. [Upgrade instructions](../../upgrade-guides/next/openai-custom-tool-payloads.md)
cover clients that relied on the previous response shape or automatic repairs.

## Cloud Code content request identity

The HTTP `User-Agent` for `generateContent` and `streamGenerateContent`, including warmup,
uses the Hub client identity with the verified version/build pair `2.17.0` / `986210228`.
The IDE-version resolver continues to own discovery, noncontent requests and request-envelope
`userAgent` values. The HTTP identity does not rewrite the envelope or change endpoint selection.

Live comparison established that changing only this HTTP header changed the same Daily
content request from 404 to 200. Endpoint switching alone did not resolve that comparison.
A future Hub version/build update
requires a live-provider check; model availability can change independently of local tests.

## Verification evidence

Focused coverage lives in `proxy-tool-stream-compatibility.test.ts`,
`tool-generation-failure-mappers.test.ts` and `gemini-tool-generation-audit.test.ts`, alongside
the owning mapper and real-path parity suites. `proxy-reasoning-usage.test.ts` covers modality
statistics through Chat and Responses, including the streamed boundary adapter;
`claude-response-usage.test.ts` checks Anthropic unary/start/final usage parity.
`gemini-client-proxy-hot-reload.test.ts` checks
the content HTTP identity at the transport boundary and preservation of the envelope.
These tests include late/missing usage,
transport interruptions, cancellation, mixed text/tools, synthetic stream fallback and
sanitized upstream diagnostics. Native HTTP/SSE acceptance and live-provider acceptance
are separate evidence; see [the testing strategy](../../testing.md).

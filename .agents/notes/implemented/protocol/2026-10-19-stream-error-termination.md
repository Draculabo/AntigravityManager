# Agent Note: Structured stream errors and termination ownership

Status: implemented

## Problem

The internal SSE decoder treated embedded upstream errors as ordinary Gemini
responses. Aggregators could therefore return an empty successful answer after
an error, and protocol consumers could lose the original status and message.

## Decision

Decode embedded errors as a first-class result carrying bounded structured
fields. Aggregation and protocol consumers stop on that result. Empty, invalid
and ineligible incomplete streams fail explicitly. Eligible transport interruption
after validated partial output follows the adopted protocol terminal contract.

Unknown nonempty string terminal reasons are provider protocol failures. The
direct-response boundary and internal SSE decoder reject them before normal
completion or account-success commit. The typed cause survives collection and
Anthropic's first-event gate so retry owners cannot turn it into another
generation. A later supported reason cannot overwrite that failure. Existing
known terminal states and refusal handling remain unchanged.

At Gemini's HTTP boundary, all three generation/counting actions preserve a typed
upstream error status only when it is an integer in the HTTP error range. Invalid
or missing upstream error statuses become 502 rather than a successful response
or a guessed status from message text. Local HTTP exceptions retain their own
status; unknown local exceptions remain 500. This keeps failure ownership with
the provider boundary without changing account retry or admission policy.

The client retains a safe transport category for Axios failures without a response,
and preserves native string codes when discarding transport object graphs. All
protocol HTTP owners share status projection: actual HTTP errors and local typed
exceptions take precedence; timeouts without a response map to 504, and connection,
network or transfer failures map to 502. Known codes take precedence over message
fallback. Local cancellation keeps its existing status while remaining distinct
from timeout; this slice introduces no new local 499 contract or retry budget.

Public generation HTTP messages share a gateway-owned projection that reuses
diagnostic text redaction before applying a 2048-byte UTF-8 limit. Status
classification continues using the original error. Error objects are retained
internally without mutation; their stack and auxiliary fields are not added to
the response. Endpoint diagnostic logs redact text separately and retain all
stack frames. This is not a complete allowlist for provider details or tool arguments.

Generation SSE failure senders and the terminal-exception fallback use the same
message projection without changing existing protocol codes/types. Gemini gates
complete data events before forwarding them; it normalizes framing while keeping
valid data, fields and comments. Otherwise a fragmented error can expose raw
message/details before the final fragment identifies it as an error. Invalid JSON
fails at that gate rather than being forwarded as opaque text.

The Gemini EOF-tail parser carries the same typed error into the public error
projection as the ordinary event path. The Anthropic first-event wrapper uses
that protocol's shared public message sanitizer even on its post-admission
exception path. Anthropic idle heartbeats use the Messages `ping` event and
remain excluded from the readiness gate and business-progress timers.

Responses distinguishes normal upstream EOF from premature close while mapped
frames are suspended by backpressure. Normal close after EOF does not overwrite
queued successful finalization. The queued EOF validator still rejects missing
finish reasons, and disconnect cleanup remains owned by the stream/pump.

HTTP code/type projection belongs to the gateway transport boundary after status
resolution. OpenAI uses status-based fallback types and adds code/param only for
known local validation classes. Ambiguous parameter ownership is represented as
null, not guessed from error text. Anthropic uses its documented HTTP error
types, after applying the existing upstream-403 compatibility exception. Private
provider bodies and arbitrary exception properties never define these machine
fields. A validated Google status enum can also supply the OpenAI provider code;
unknown provider fields cannot. SSE and WebSocket retain their protocol envelopes
while sharing status-based classification and public message sanitization. Gemini
projects only bounded public ErrorInfo identities from recognized Cloud Code
domains; arbitrary metadata and help links stay private. Existing safe Fastify
request IDs provide transport correlation, without accepting another identity
from arbitrary headers. Public text excludes embedded stack frames and recognized
absolute paths.

Generation shape validation and primary-candidate output evidence are shared
between unary aggregation and SSE consumers. Whitespace, signatures and usage
alone do not establish an answer. Anthropic no longer fabricates a period or
one-token usage for an empty result. Explicit refusals and truncation remain
separate terminal facts.

The optional `experimental.thinking_only_recovery` configuration defaults to true
when absent; an explicit false disables it. It authorizes one continuation only after real primary-candidate
thought and normal STOP, with no answer, tool, media, error, refusal or competing
candidate. The original request is cloned under the existing retained-output
budget, receives a locally chosen user continuation and a new child request ID,
and uses the captured account/model/thinking/tools/endpoint/proxy/header snapshot. A trailing
user turn receives one text part instead of a consecutive user message. The child
reapplies signature wire encoding without restoring newly captured thought or
starting account, endpoint, signature, cache or session recovery chains.

The eligible first finish and usage stay withheld. Latest usage snapshots are
added across physical attempts, without replacing unknown inputs with zero or
presenting the first attempt as a combined total. Cancellation releases streams
and listeners; an unsettled child retains its memory credit until settlement.
Attempt audit records retain actual HTTP status independently from generation
outcome, so HTTP 200 with an empty answer or embedded failure is not an audited
generation success. A successful continuation cannot rewrite that first attempt.

On 2026-11-07 the user approved partial-output interruption finalization.
Shared generation evidence
identifies previously validated visible text or a complete tool call. Each
protocol adapter owns its terminal frames. Chat uses `length`, Anthropic uses
`max_tokens` and native Gemini uses `MAX_TOKENS` for interrupted text. Existing
complete tool calls retain `tool_calls`, `tool_use` or `STOP` respectively.
Responses retains a failed terminal result carrying its partial output.

The selected behavior lets clients retain partial output using their normal
protocol completion path. It preserves model text, complete tool arguments and
the latest observed usage. It neither repairs Markdown nor adds warning prose.
Gemini carries a fixed interruption marker in its terminal candidate.

Physical attempt audit outcome remains interrupted or failed. Synthetic terminal
frames do not commit account/model success or trigger a replacement generation.
Anthropic carries an invocation-owned interruption marker through its preflight
wrapper so ordinary Observable completion cannot commit false success.

Eligibility excludes thinking-only or whitespace output, signatures, inline
media, ambiguous multiple candidates, structured provider failures, invalid
protocol data, signature conflicts, caller cancellation and the total generation
deadline. Normal EOF validates buffered UTF-8 and SSE before finalization. Image
generation retains clean-end requirements, and an existing terminal reason wins.
See the current [partial-output interruption contract](../../../../docs/modules/proxy-gateway/stream-tool-compatibility.md#partial-output-interruption).

## Alternatives considered

Keeping errors inside a response object was rejected because each protocol then
had to guess whether empty candidates meant failure. Returning an empty answer
for DONE-only or malformed streams was rejected because it hides provider
failures and can commit false success state.

Mapping an unknown terminal reason to STOP was rejected because it claims a
completion fact the gateway does not understand. Retrying another account or
falling back to a second generation was rejected because the provider's terminal
vocabulary is not an account availability signal and a tool call may already
have been delivered. The public message is fixed; bounded original values remain
in internal diagnostics, with full enabled captures governed by existing limits.

Returning 500 for every Gemini generation failure was rejected because it loses
known upstream status that counting and the other protocol boundaries preserve.
Inferring the status from free-form error messages was rejected because unrelated
quota or numeric text can override the actual provider failure.

Reducing every Axios error to its message was rejected because opaque timeout
messages lose the only reliable cause. Retaining the complete Axios error was
rejected because request/configuration graphs may be circular or sensitive.
Separate per-protocol transport classifiers were rejected because identical
provider failures must not acquire different HTTP meanings at each boundary.

Truncating before redaction was rejected because replacement markers can expand
short values past the final message limit. Applying the public preview cap to
diagnostic stacks was rejected because it would lose frames required for local
failure diagnosis. Changing status classification to consume sanitized text was
rejected because removing credential-like text must not change HTTP semantics.

Redacting only Gemini's final error frame was rejected because earlier fragments
could already have crossed the public boundary. Treating every Readable close
as an interruption was rejected because normal EOF may precede draining the
final mapping iterator; ignoring premature close was also rejected.

Using `server_error` or `api_error` for every HTTP failure was rejected because
clients cannot distinguish malformed requests, authentication and rate limits.
Copying machine fields from rendered provider bodies was rejected because that
text is truncated, potentially sensitive and belongs to a different protocol.
Inventing a parameter path for a schema root, multiple conflicting aliases or
model-derived effort was rejected because it would direct clients to the wrong
field.

Always-on continuation was rejected because it silently adds provider cost and
can obscure empty output. Retrying truncation, refusal or a delivered tool was
rejected because it changes their semantics or risks duplicated execution.
Appending newly generated thought as an assistant turn was rejected because it
would invent missing signed history. Returning task-ready text after recovery
failure was rejected because it represents an unfulfilled request as success.

Keeping explicit failure for every network interruption after usable output was
replaced for Chat, Anthropic and Gemini following user approval. Some clients
reject incomplete streams despite receiving useful text. A protocol terminal
sequence addresses that compatibility case while physical diagnostics retain
the interruption. Treating every error as eligible was rejected because provider
denials, invalid data and cancellation have different owners. Applying this
policy to Responses was rejected because its failed result already carries
partial output. Repairing code fences or adding warnings to model text was
rejected because it changes the generated content.

## Consequences

Invalid streams and explicit provider failures retain explicit error results.
Eligible interrupted partial output receives protocol terminal frames that some
clients treat as token truncation or completed tool delivery. The physical request
remains a failed attempt and is excluded from success commits. Terminal-frame and
public error mapping belong to each protocol owner. Tool clients may proceed with
already emitted complete tool calls, and final usage may be unavailable. Installed
client and live-provider behavior require separate acceptance.

Enabling continuation can perform one additional provider request. Existing
profiles remain valid because the new field is optional; turning it off restores
explicit empty-answer failure without a durable format migration. Recovery never
executes tools or rewrites permanent user history.

## Verification

See D11 implementation report (local artifact `D11-error-termination-implementation.md` in the 2026-10-11 review collection) and the focused internal SSE/aggregation tests.
The Gemini HTTP status matrix exercises all three controller actions, preserves
valid 4xx/5xx statuses, rejects invalid statuses, and checks local validation and
admission neighbors. It is controlled controller evidence; provider behavior and
packaged clients require separate acceptance.
The unknown-finish-reason regression exercises all four protocol services, direct
responses, aggregation, delivered partial streams and HTTP error projection. It
also checks first-event rejection, completed-history exclusion and known terminal
neighbors. Synthetic upstreams and account leases replace external boundaries.
The transport regression drives Axios failures through the production client and
all HTTP owners, with additional real account/retry paths, native clean-error
checks, cancellation and actual-status neighbors. Axios and account persistence
remain controlled substitutes; no live network behavior is established.
The public HTTP-message matrix covers all four generation protocols, Gemini
validation/actions, unresolved-file branches, complete emitted text bounds,
preserved safe tool errors and production account/retry paths. Synthetic secrets
establish only the existing redaction patterns. Its diagnostic-log case verifies
that a redacted 1000-frame stack remains complete.
The public stream matrix covers all four production protocol services with
controlled upstream chunks/account leases, secret-bearing and oversized messages,
fragmented/mixed errors, transport failures and preserved successful neighbors.
Gemini gate cases cover same-chunk partial output, multiline/CRLF/adjacent/tail
records, invalid JSON and retained SSE fields. Writer tests cover both flow modes
and original diagnostic-cause retention. Existing lazy-frame demand tests and an
EOF-without-finish neighbor verify the normal-close distinction.
The HTTP field matrix covers local HTTP statuses, known validation classes,
provider 403 projection, private-body exclusion, pool Retry-After and production
service/retry paths. The schema admission regression still verifies failure
before account selection with no upstream calls or penalties.
The consolidated controlled suite additionally exercises malformed unary/SSE
contracts, empty/refusal/truncation neighbors, opt-in continuation through all four
production protocol services and the real Axios client boundary, cancellation,
memory credit, transport snapshot identity, physical attempt audit outcomes and
usage snapshot accounting. Provider HTTP is intercepted, leases and persistence
are synthetic, and WebSocket projection uses a loopback server. Native workers,
packaged clients and live providers remain separate acceptance boundaries.

The 2026-11-07 adoption adds regression cases in the public four-protocol stream
matrix for text and complete tools followed by EOF or a transport reset. Focused
Anthropic checks cover idle expiry, premature close, signature ownership and
exclusion from account/model success. The loopback HTTP integration exercises
actual SSE output through the protocol controllers with a controlled upstream.
Negative controls and executed command results are recorded in the incremental
review artifacts. These checks substitute the provider and account boundary.
They do not establish installed-client rendering or live-provider behavior.

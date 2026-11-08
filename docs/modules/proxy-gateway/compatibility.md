# Proxy Compatibility Reference

## Fallback diagnostics

OpenAI, Gemini and Anthropic Messages responses include `x-antigravity-attempts` and
`x-antigravity-fallback: true` when more than one upstream operation has started and at
least one has failed before headers are sent. Successful cache creation followed by
successful generation does not count as fallback. Streaming headers describe the state
at first output; later failures cannot revise headers already sent.

Traffic Monitor distinguishes total attempts from failed attempts. A completed request
receives a recovery indicator only when its retained attempt records contain a failure.
The detail summary identifies a successful attempt after the final recorded failure.
Dropped audit writes can leave fewer retained attempts than the response headers report.
HTTP 403 responses containing `SERVICE_DISABLED` or a disabled-API message are classified
as upstream errors in audit presentation; ordinary credential failures remain authentication
failures. This classification does not change retry or account-selection policy.

## Model routes, variants and capability evidence

OpenAI model list/retrieve keep their identity fields and local context/output limits.
Context metadata is published as `context_length`, `max_context_length`,
`max_input_tokens`, `max_model_len` and `max_tokens`. Output metadata is published as
`max_completion_tokens` and `max_output_tokens`. The fields within each group are
identical; model metadata's `max_tokens` does not change the generation parameter's
output-limit meaning. List, retrieve and service probes share the same catalog.
Gemini list/retrieve use the same local model specs for `inputTokenLimit` and
`outputTokenLimit`, including configured alias targets and documented family fallbacks.
They do not report a live provider entitlement or measured token count. Gemini and
Anthropic lookup select an exact catalog ID first, then a unique case-folded match;
ambiguous matches return 404. Gemini also accepts the existing `models/` name prefix.

`GET /props` and `/v1/props` expose llama.cpp-compatible discovery metadata.
The optional `model` query is one non-empty string, matched exactly against the
published OpenAI catalog. Omission selects `gemini-3-flash`; an unavailable default
or explicitly unknown model returns the existing `model_not_found` 404 envelope.
An empty or repeated `model` returns 400. Other query fields, including Hermes's
`autoload=false`, do not cause model loading or any other runtime mutation.
`default_generation_settings.n_ctx` and `n_predict` contain the selected model's
context and output limits; `model_alias` is its public ID, including a requested
alias. `total_slots: 1` is a compatibility placeholder, not measured concurrency.

`GET /version` and `/v1/version` return the application package's actual `version`,
with its package name in `app` and `name`. All four discovery routes use the normal
proxy guard, including configured API key and network policy. They acquire no
account lease, perform no upstream requests and write no persistent state.

Hermes probes `/v1/props` then `/props` and recognizes this response as its llama.cpp
compatibility branch. Its context query requests `/props?model=...&autoload=false`
and can read the existing model list/detail routes. `/version` is its vLLM detection
fallback; `/v1/version` is an additional compatibility alias. These discovery
responses do not advertise the full native llama.cpp or vLLM administration APIs,
nor do they establish installed-client or real-provider acceptance.

The existing `/v1/models/claude` directory returns one complete page with `data`,
`first_id`, `last_id` and `has_more: false`. List items and retrieve share `type: model`,
`id`, `display_name` and `created_at`. The epoch creation date indicates unknown provider
release time. This gateway projection does not implement provider capability/lifecycle
metadata or cursor filtering. See the [field upgrade instructions](../../upgrade-guides/next/model-directory-metadata.md).

Model requests resolve user rules in this order: runtime deprecation forwarding,
exact configured alias, a unique case-folded alias, a unique Claude-normalized
alias, the most specific wildcard, the existing Anthropic family setting, built-in
or canonical mapping, then passthrough. Exact aliases remain case-sensitive and
win before equivalent lookups. Wildcards rank by the number of non-wildcard
characters and use configuration order for ties. Equivalent aliases that point to
different targets fail explicitly instead of selecting one by iteration order.

Name normalization trims surrounding whitespace before removing a leading
`models/` path segment. Claude comparison additionally removes a leading
`anthropic/` segment, folds case and replaces dots with hyphens. Unknown names
still pass through with their capability unknown. A configured physical target is
not fed back through its public alias.

A bare tiered family resolves only against physical candidates advertised by the
selected account. With no effort it prefers `tiered`, then `medium`, the lowest
candidate above `low`, `low`, and finally the family's advertised fallback.
Explicit effort is normalized for surrounding whitespace, case and underscores:
`extra-low`, `min`, `minimal` and `lite` select the lowest tier;
`x-high`, `xhigh`, `max` and `extreme` select `high`. An unknown effort returns
HTTP 400 before account selection. Explicit physical tier IDs are not changed by
request effort.

Account availability and physical binding preserve explicit tiers. A missing
explicit tier does not select another tier merely because the account advertises
it. Registered public presets retain their defined physical recipes, including
Gemini 3.5 Flash Low through `gemini-3.5-flash-extra-low` and Gemini 3.1 Pro High
through `gemini-pro-agent`. Registered automatic Flash routes retain their physical
`tiered` ID and adaptive budget regardless of request effort. Fixed High profiles
do not bind to automatic profiles merely because both are registered as High.
Explicit provider retirement rules retain their existing registered-recipe safety check and may
name a replacement tier. Bare-family nearest-tier selection remains available.

Capability failures are scoped to an account and known model family for 900
seconds. A failure on account A does not block account B, and a denial for one
family does not block another model on A. The record is enforced even when an
account's catalog is missing, survives an ordinary account-cache reload, and is
cleared only by matching generation success or expiry. A catalog or quota refresh
is not positive generation evidence.

Status codes alone do not establish incapability. The gateway records only
structured model reasons or explicit text naming the current physical model.
Project, endpoint, authentication, validation, security-policy, tool and schema
failures remain with their existing owners. Ambiguous 404 and all 403 credential
or account-validation responses do not create a capability denial.

## Account Scheduling and Stream Completion

Automatically controlled thinking requests can recover once from an explicitly
overloaded upstream generation response on the same account. Admission requires
HTTP 408 or a server-error status with explicit `overloaded` text, or trusted
Google ErrorInfo `MODEL_OVERLOADED` evidence. Quota and capacity-exhaustion
diagnostics retain their existing owners. The final wire budget must be adaptive
`-1`, with at least 5024 output tokens available for a 4000-token thinking budget
and the existing 1024-token output reserve.

Chat, Responses, Anthropic and Gemini capture explicit thinking intent before
variant/default processing. Explicit client controls, configured physical routes,
fixed-tier names/recipes and image generation are excluded. Bare Gemini families
may acquire a registered recipe during routing; their final adaptive wire budget
determines eligibility. Configured positive budgets retain their selected value.

The additional send uses an immutable copy of the failed wire body with thinking
budget 4000 and the captured account, session, endpoint, proxy and headers. The
allowance belongs to one logical request across account/project/protocol fallbacks.
Its admission rechecks cancellation, the existing total deadline and account lease.
Failure returns to the existing retry policy. A returned stream is never replayed
by this recovery path. The structured `overload_thinking_retry` diagnostic carries
the model, budget, local account ID and audit request ID when available.

Anthropic `messages/count_tokens` uses the admitted mapped input for a complete local
estimate by default, with source `estimated` and reason `anthropic-local`. It does not
lease a provider account, contact upstream or commit account affinity. Proxy authentication,
file resolution, schema conversion, media limits and tool-history validation still apply.
Its count includes submitted historical images even when generation's send window is enabled.
Unavailable local media coverage returns 503; local estimation does not imply generation
access, provider eligibility or a successful model request.

Gemini token-count responses admit only nonnegative safe integers from upstream; zero is valid.
An unusable upstream count follows the existing operational-fallback policy. The internal
count endpoint only accepts contents/model. Requests whose system instructions, tools or
tool configuration are outside that coverage return a complete local estimate with
`X-AGM-Count-Tokens-Source: estimated` and reason `upstream-contents-only`, even when the
contents count succeeded. The contents-only upstream number is not a full request count.
A local estimate with unknown media coverage fails with 503 instead of reporting a partial
total as complete. Valid upstream counts can still cover that media. These heuristics are
neither provider usage/billing nor a hard model-window measurement.

Native Gemini token counting propagates downstream cancellation to account selection,
retry grace and upstream count transport. Cancellation cannot produce an estimated 200,
commit account affinity or accept a late count as success. A stopped requester releases
its waiter even if a substituted dependency fails to honor abort; the real transport
also receives the signal. File expansion and synchronous conversion remain non-preemptive.

Ordinary generation and token-count operations stop rotating after two distinct
accounts have returned HTTP 429 without a parsed retry hint or explicit durable
quota signal. The first account counts toward this budget. Image scheduling uses
its existing independent policy. Hint-bearing and hard-quota failures do not
consume this transient budget; the existing outer attempt limit still applies.

When another ordinary candidate is selected after HTTP 429 in the first round,
the shared retry owner waits 50 ms before returning it to the protocol operation.
Other failures retain jittered backoff. Round exclusions are separate from the
request-wide attempted-account history. When no untried candidate remains, a
later round can reuse currently eligible accounts within the original ceiling.
The owner observes the shortest current transient cooldown without clearing
locks: each wait is capped at 30 seconds for a single-account pool and 12 seconds
for a larger pool. A remaining lock after that wait ends selection. Forbidden,
validation-blocked, OAuth-disabled and hard-quota accounts do not qualify for
this waiting; account-first also excludes depleted model quotas.

Ordinary same-account HTTP 429 grace is available once per account and consumes
no normal attempt slot, including Anthropic generation and both token-count
surfaces. Multi-account first rounds rotate; later rounds allow a parsed actual
wait of at most five seconds. Single-account pools allow a parsed actual wait of
at most 30 seconds or, without a hint, `min(3 seconds * normal attempts used, 10
seconds)`. The actual wait includes the existing source buffer. Explicit hard
quota never qualifies for grace. Longer hints use capped normal waiting; existing
shared locks take precedence over shorter computed backoff. Model variants follow
the ordinary policy without changing their request configuration.

Retry waits support cancellation and cannot cross the request's remaining
configured time. That deadline starts with retry-state creation and is not renewed
by grace or round changes. Cached grace tokens are checked against current
eligibility immediately before reuse. Retry selections suppress both cache-first
waiting and the selector's short-pool fallback wait, preventing stacked waits.
The initial selection retains its existing behavior; credential hydration and
initial selection waits can still add latency. This is a retry-wait deadline,
not a replacement for transport or hydration timeouts.

Generation services additionally enforce one `request_timeout` budget across service
preparation, account/endpoint waits, cache/session/thinking recovery and returned stream
lifetime. Internal physical sends receive only the remaining timeout. A business deadline
is terminal 504 and does not rotate or penalize another account. Pausing output or sending
heartbeats does not extend it. Client disconnect remains cancellation. The owner releases
timers, listeners and image permits; shared cache/SQLite work retains its own cleanup owner.
Once a streaming upstream attempt starts, deadline diagnostics record the furthest validated
output phase. The phases are `waiting_for_output`, `thinking_only` and `output_started`.
Heartbeats and usage metadata do not advance the phase. The diagnostic records the phase
and the audit request ID when available.
The main HTTP Chat/Responses, Messages and Gemini generation controllers start it before
file/history expansion. Direct service calls start at service entry. Responses WebSocket
starts its per-message budget at dispatch, before transcript admission. WebSocket queue
residence and HTTP body/multipart parsing retain their existing owners. Legacy completions
own the generation dispatch and stream lifetime. Image Chat dispatch and its native Gemini
protocol fallback share one owner; the fallback receives only the remaining budget.

Gateway upstream requests use HTTP CONNECT when an account, application or environment
proxy is selected. Explicit account and application settings take precedence over the
environment. Environment selection honors `NO_PROXY`. Proxy authentication is sent on
CONNECT and HTTPS origin headers travel inside TLS. The gateway bounds CONNECT by the
attempt timeout and keeps a stream's tunnel open until it ends or closes. See the
[proxy upgrade guide](../../upgrade-guides/next/upstream-proxy-connect.md).

Each gateway client owns a bounded transport pool keyed by the complete proxy endpoint
and credential fingerprint. Direct HTTP and HTTPS use separate native agents. The pool
admits 20 active physical requests per proxy identity and retains up to 16 identities.
Each agent has 20 total sockets and at most four idle sockets per destination. Idle
sockets and fully idle pool entries expire after 90 seconds. TCP keepalive uses 60 seconds.
Active streams retain their admission slot until end or close. Saturation returns a local
503 before creating a physical attempt and preserves account health. Proxy changes use
a different entry while earlier requests finish. Gateway shutdown cancels active work
and destroys the client's agents.

Internal sends use the gateway's generated HTTP User-Agent. Extra headers cannot replace
it through another casing. Legitimate protocol headers, including `anthropic-beta`, retain
their protocol contract. A recovery that reuses a transport snapshot retains its captured
identity.
A response save admitted before timeout can finish under its persistence owner. See the
[upgrade guide](../../upgrade-guides/next/generation-deadline.md).

Generation sends the account's project in the body when available. The generation service
permits one body retry without it for the known Code Assist license rejection or an error
that identifies the submitted project as invalid, missing or denied. Account rotation retains
each account's project and shares the original downgrade allowance. The execution signal
carries that allowance across image protocol fallback. The image adapter accepts the known
license rejection or a transport-validated consumer denial only while the allowance remains.
An unmatched project message or a status outside 400/403/404 preserves the original failure.

OpenAI stream establishment rejected with ordinary HTTP 429 enters this shared
rotation policy rather than issuing a non-stream request on the same account.
Other existing establishment fallbacks remain. All-rate-limit failures retain
429 semantics; mixed failures retain the last non-rate-limit diagnostic.

Ordinary operations snapshot their potential model-capable account pool before
entering the loop. Pools of zero or one account have three normal attempt slots;
larger pools have `pool size * 2`, bounded to 4–12 slots. The snapshot excludes
validation-blocked accounts and accounts whose OAuth refresh is disabled. It
includes temporarily cooled or quota-depleted potential accounts, so those
temporary states do not redefine the ceiling; each selection still enforces
current eligibility and locks. The snapshot loads the local account cache when
empty, without hydrating credentials or discovering projects. Image operations
retain their existing three-slot ceiling.

The ceiling is an upper bound, not a guaranteed send count. The two-account
generic 429 stop, current locks, cancellation and retry-wait deadline can end an
operation earlier. Grace remains separate from normal sends and cannot renew the
ceiling. Image scheduling, permits and grace keep their existing independent
behavior. Session and account-first affinity commit after upstream success; see
[account leases](account-leases.md#successful-account-affinity) for commit points,
concurrent failure protection and lifecycle limits.

Eligible accounts are selected with bounded model-quota weights when `proxy.quota_aware_scheduling_enabled` is true (the default). Each account's resolved upstream model selects its quota snapshot. A reported quota percentage below 25 or an unknown value has weight 1, 25–74 has weight 2, and 75 or above has weight 3. Existing model-capability, health, cooldown, and session-affinity rules still run before weighted round robin. The quota snapshot is only a preference: it never makes an ineligible account eligible and does not reserve capacity. Setting the switch to false restores equal-weight selection.

Synthetic OpenAI Chat and Responses streams created from a completed non-stream response preserve reasoning before visible text. Chat emits `delta.reasoning_content`; Responses emits reasoning summary events. Live streams retain previously emitted content when the upstream connection is interrupted. See [partial-output interruption](stream-tool-compatibility.md#partial-output-interruption) for protocol-specific termination and eligibility. Once any response event has been sent, the gateway does not replay the request against another account because that could duplicate visible output or tool calls.

Responses reports interruptions through `response.failed` and excludes failed responses from completed history. An entirely empty native Gemini stream raises its existing empty-stream error. Anthropic retains its preflight retry behavior before mapped output. See [streaming liveness and backpressure](stream-tool-compatibility.md#streaming-liveness-and-backpressure) for heartbeat and pause behavior.

Gemini `generateContent`, `streamGenerateContent` before SSE delivery, and `countTokens`
preserve a typed upstream HTTP error status in the 400–599 range. Their JSON error
contains that numeric code and the existing Gemini status mapping. An unusable provider
HTTP error status produces 502; message text cannot override the status. Transport
failures without an HTTP response follow the classification below.
Local validation and account-admission exceptions retain their own HTTP
status and the existing account-pool `Retry-After` behavior. Unclassified local
exceptions remain HTTP 500.

## Upstream transport failures

Before response delivery, all four protocol boundaries preserve valid upstream
HTTP statuses and local validation/admission exceptions first. Without a provider
HTTP response, recognized timeout errors produce 504; connection, DNS/network
and interrupted-transfer failures produce 502. Known transport codes take
precedence over message text. `ECONNABORTED` from Axios is a timeout;
`ERR_CANCELED`, `ABORT_ERR` and `AbortError` retain cancellation identity.

The client carries only a classified transport category in its typed upstream
error. Native clean errors retain their string code and abort name without
retaining request/configuration graphs. Legacy errors with no known code use
message fallback, including `timed out`, deadline and body-read reset wording.
Unclassified errors retain the owning protocol's existing fallback. Local
cancellation keeps its existing 500
projection and cannot become 504 merely because its message mentions timeout;
an actual upstream HTTP 499 is preserved. This does not introduce a new local
499 contract or alter account/endpoint retry budgets. Anthropic alone retains
its existing typed upstream 403 to public 503 compatibility mapping.

## Public HTTP error messages

Generation HTTP errors in OpenAI Chat/Responses, Anthropic Messages and Gemini
use the shared diagnostic text redaction rules for authorization values, named
credentials, URL credentials/query secrets, email addresses and local user names.
The complete redacted message is limited to 2048 UTF-8 bytes, including its
truncation marker, without splitting a Unicode code point. Empty messages become
`Request failed.`. Validation and unresolved-file messages use the same projection;
file error codes and parameter paths retain their existing meaning.

Status resolution uses the original error before text projection. Top-level
envelopes, Retry-After and the Anthropic upstream-403 exception remain unchanged.
The original Error is not mutated or serialized wholesale into the response.
OpenAI/Anthropic endpoint logs redact their message and complete stack separately;
the public message limit does not truncate diagnostic stack frames.

Generation SSE error messages use the same policy; see
[stream error projection](stream-tool-compatibility.md#public-stream-error-messages).
Responses WebSocket errors share message projection and HTTP-style classification.
Public text also removes embedded stack frames and recognized absolute local paths.
Auxiliary APIs and diagnostic captures retain their owning boundaries. The gateway
does not copy arbitrary provider payloads or tool arguments into error envelopes.

## HTTP error classification and local fields

OpenAI compatibility errors classify public 4xx responses as
`invalid_request_error`, except 429 as `rate_limit_error`; public 5xx responses
use `server_error`. This is the gateway's fallback classification, not a copy of
arbitrary Google error types. Actual HTTP status continues to take precedence
over free-form error wording.

Anthropic HTTP types follow the
[official error table](https://platform.claude.com/docs/en/api/errors):

| Public HTTP status | Anthropic error type                                          |
| ------------------ | ------------------------------------------------------------- |
| 401 / 402 / 403    | `authentication_error` / `billing_error` / `permission_error` |
| 404 / 409 / 413    | `not_found_error` / `conflict_error` / `request_too_large`    |
| 429 / 504 / 529    | `rate_limit_error` / `timeout_error` / `overloaded_error`     |
| Other 4xx / 5xx    | `invalid_request_error` / `api_error`                         |

Type selection occurs after the existing Anthropic upstream-403 to public-503
projection. Such an error remains HTTP 503 / `api_error`, while a local HTTP 403
uses `permission_error`.

Known local OpenAI validation failures add gateway-owned machine fields:

| Failure                   | `error.code`                      | `error.param` |
| ------------------------- | --------------------------------- | ------------- |
| Schema validation         | `invalid_request_schema`          | `null`        |
| Tool history association  | `invalid_tool_history`            | `null`        |
| Tool choice configuration | `invalid_tool_choice`             | `tool_choice` |
| Conflicting output limits | `conflicting_output_token_limits` | `null`        |
| Unsupported model effort  | `invalid_model_effort`            | `null`        |

`null` means the gateway has no single precise public parameter path; it does
not parse one from the message. A validated Google status enum supplies OpenAI's
provider error code with `param: null`; an unknown status string stays private.
Other errors keep code/param absent. Existing file-reference and Responses history
errors retain their own specific code/param contracts.

Gemini preserves the validated provider status and exposes at most eight public
`google.rpc.ErrorInfo` identities from recognized Cloud Code domains. Only a bounded
uppercase reason and the domain are projected; metadata, help links and unknown
detail types remain private. Bare/wrapped provenance and a 32 KiB UTF-8 diagnostic
message limit with a truncation flag remain available on the internal typed cause.
Generation error replies and SSE headers reuse a safe existing Fastify request ID
as `X-Request-Id`; Anthropic HTTP errors also include `request_id`. Arbitrary request
headers do not define a new public identity.

## System prompt normalization

Claude system blocks, initial OpenAI system/developer blocks, Responses instructions
and native Gemini system parts share one system-text normalizer. Only initial
contiguous system/developer messages enter the initial instruction; later reminders
remain at their original conversation position. User-supplied repetitions and
dynamic dates, paths, UUIDs and request/session identifiers remain significant.

Exact standalone Claude Agent SDK identity maps to Claude Code. Other recognized
English attributed identity heads can become `You are an AI Agent.` only when
they contain an identity opening, an agent/assistant/AI noun and an adjacent
attribution verb. Recognition covers at most the first four sentences and 8192
UTF-16 code units of each system block; version decimal points do not count as
sentence endings. Comma continuations and surrounding whitespace remain intact.
Ordinary business roles, quoted identities and later mentions are preserved.

Only complete `x-anthropic-billing-header:` lines are removed from unprotected
system text. Matching retains original line offsets. Markdown code fences honor
their delimiter width/character, including unclosed fences; inline code,
blockquotes, XML comments and explicit quote/example/code/pre regions remain
unchanged. No global trim, blank-line collapse or placeholder/ID replacement runs
after cleanup. Ordinary user/tool input and signed/thought history are excluded.
Literal `[undefined]` remains data, and mapper cleanup does not mutate argument
objects by recursively deleting optional properties.

An enabled global prompt is prepended as one dedicated section by its owning
mapper. Configured whitespace and caller repetitions remain intact, including
quoted matches and matching section tags. Caller text cannot suppress configured
injection by substring equality. Existing image-path exclusions remain.
Generation services snapshot this resolved setting before asynchronous account selection.
The same value, including disabled/null, reaches account/project fallbacks and stream
establishment; a subsequent logical request observes saved changes. Direct mapper and
count callers retain their explicit current-configuration behavior. Native envelopes keep
static configuration before dynamic contents in deterministic construction order.

These rules describe local request transformation. They do not establish a live
provider rate-limit, WAF or cache improvement.
See [complete context observation](inline-media-and-thought-history.md#complete-context-observation)
for bounded transformation metadata and exact physical-send byte/estimate diagnostics.

## Generation history admission

Chat, Responses, Messages and native Gemini generation reject histories with no
effective business input, an unanchored assistant start or missing tool results
before account selection. Initial system/developer instructions alone are not
business input. Media and actual tool exchanges remain eligible; call/result
identity is checked by the existing association owner. Cancellation and native
signature/model validation retain their precedence.

Supported anchored assistant prefill keeps its role and exact text. Only a
non-image Gemini target receives one `ok go on` user tail in a temporary outbound
copy. Claude and other targets keep their tail. Repeated preparation is
idempotent; signed/thought turns retain whitespace companion parts. The gateway
does not insert dummy thinking, `Continue` for empty history or a fabricated
initial user task. Count-token requests bypass generation admission and the
generation-tail adapter, and still send only contents upstream.

An Anthropic upstream 400 narrowly classified as a thought-signature rejection
propagates without replay, scope-wide cache invalidation, account penalty or
rotation. Proven wire encoding and exact scoped missing-signature lookup remain.
The gateway does not convert thinking to visible text, guess tool outcomes or
append regeneration directives to repair that rejection. See the
[client upgrade instructions](../../upgrade-guides/next/retain-tool-call-history.md).

## Explicit Quota Resets and Flash Routes

An HTTP 429 classified as a transient rate limit, with generic `RESOURCE_EXHAUSTED`
content and no parsed retry hint, uses account-wide cooldown escalation of 5, 15,
then 30 seconds. Subsequent failures remain at 30 seconds. The history expires one
hour after the last qualifying failure and resets after an upstream model success
or an explicit tracker reset. Expiring an individual cooldown does not reset the
history. The actual lock stays scoped to the affected model; another model can
remain available even though its next qualifying failure shares the account's step.

Explicit retry hints take precedence and do not advance this staircase. Other
rate-limit, capacity, server and durable quota classifications retain their own
policies. A success resets this account-wide history without clearing another
model's lock. The shared tracker serves ordinary and image-account penalty paths;
this escalation does not change request attempt budgets, grace retry eligibility,
image permits or the existing stream commit point.

An HTTP 429 with an explicit `QUOTA_EXHAUSTED` marker and a reset hint longer than five
minutes retains that deadline for the account and actual upstream model. An exhausted model's exact
quota reset timestamp also retains its full duration. Generic `RESOURCE_EXHAUSTED` responses,
capacity errors and inferred retry backoff keep the five-minute transient cooldown cap.
A later transient error cannot replace active explicit quota evidence. The tracker keeps
the quota deadline and the current temporary wait separately, using the longer active wait
for selection. When the quota deadline expires, a longer temporary wait can remain without
claiming that hard quota is still exhausted. Quota refresh does not clear explicit long locks
before their deadline; a successful request for the same model releases both constraints.
Success resets account-wide resource history and the corresponding temporary failure history,
while other model locks and explicit forbidden cooldowns remain independent.

Account quota reconciliation and tracker penalties use one error-evidence classifier.
Recognized structured reasons take precedence over incidental text. Explicit weekly quota
and exhausted/insufficient credits can request quota reconciliation; they do not by themselves
qualify an inferred wait for an uncapped deadline. Only a parsed positive retry hint suppresses
that reconciliation. An invalid `Retry-After` header falls through to valid body hints or normal
quota reconciliation. Expired official reset timestamps do not create new cooldowns.

The existing model-availability record stores compact quota evidence so its 500-character
message bound cannot remove the reset marker. Account reload and process restart restore
qualified text and image quota deadlines from this record, including their final five minutes.
Later temporary limit observations retain that original qualifying record; qualification uses
its original observation time rather than the remaining duration. No durable format changes are
required. Before selecting an account, both its requested model and resolved upstream route
are checked for cooldowns. Public presets cannot bypass the physical model's quota lock.
When the pool is exhausted, the existing unavailable-account response returns HTTP 503 with
the shortest remaining model wait in `Retry-After`, without an upstream attempt.
The internal transport stops endpoint failover on an explicit long quota failure,
including a streamed error body when traffic recording is disabled. Short transient errors
retain endpoint failover and the existing bounded account rotation and grace retry policy.

Account selection accepts advertised `gemini-3.7-flash-tiered` and registered Gemini 3.6
physical routes. Automatic Flash routes use `thinkingBudget: -1`, `includeThoughts: true` and
`maxOutputTokens: 65536` in Gateway mode when no explicit output limit overrides it; fixed
low and medium routes retain their registered budgets. These parameters pass through final
account-cap and output planning. An unregistered generation is not
accepted as a fallback. Selecting an older model does not silently upgrade its generation;
provider retirement notices remain visible to clients.

## Thinking control and output planning

Gateway control uses registered model recipes and configured family budgets. Flash low and
medium nonpositive settings resolve to 1,000 and 4,000 tokens. These defaults do not apply
to an explicit Client budget.

Client control preserves disabled, adaptive and fixed budgets through model selection and
account rebinding. Budget 0 and recognized disabled effort values disable thinking. Budget
-1 remains adaptive; a positive numeric budget takes precedence over an enabled effort level.
OpenAI Chat and Responses reasoning controls, Anthropic Messages controls and native Gemini
controls reach the final planner without being replaced by a registered recipe. Account output
and thinking limits still apply. The existing Opus 4.6 output and thinking ceilings remain;
its required-thinking route rejects an explicit disable request.

For a positive budget B and explicit output M, B >= 6M reduces the budget to max(0, M - 1024).
Otherwise, an output limit that cannot hold B expands to B + 1024. Without an output limit,
text uses 1,024 output tokens above the budget and image generation uses 2,048. An explicit
image output limit uses 1,024. The final output never exceeds the account/model cap, and
cap-constrained fixed budgets leave 1,024 output tokens where possible, or one/zero tokens
of thinking at very small caps. The planner retains adjustment reasons for these changes.

## Claude Agent SDK Client Identity

Claude request mapping normalizes the exact top-level Claude Agent SDK identity sentence to the Claude Code identity before cache sanitization. The rule applies to a string `system` value and to matching text blocks in a top-level `system` array. It is intentionally exact: mentions inside longer text, whitespace-padded variants, and embedded role-bearing system messages remain unchanged.

The normalized Claude Code text remains a client customization rather than an official-provider identity marker. The mapper therefore retains the Antigravity fallback identity alongside it, preserving the existing cache and provider-routing contract.

## Cowork Coordination State

The internal compaction coordinator is separate from ordinary generation. It rejects
unknown sources and owns bounded active operations, adoption confirmations and
continuation protections. Provider summary success and a changed adopted-history
fingerprint must precede completion. Completed operations receive up to 300 seconds
to activate protection; an exact tenant/session/generation/operation/adopted-root proof
activates a 30-second sliding window. Expiry cannot revive an operation.

New operations and scoped invalidation revoke prior confirmation and protection.
Active operations reserve protection capacity; a full store refuses new coordination
instead of clearing another session. Snapshot counts expose all three stores.

Anthropic Messages connects the coordinator after restored semantic-input preparation
and before explicit cache replacement. Admission requires an explicitly selected digest
of the current proxy API key and a stable D03 session hint. The scope includes every
client sharing that key. A legacy user ID alone cannot establish the required session.

Local compaction triggers terminate before account retry or penalty. The client requests
its summary through the existing provider path. Successful provider completion and exact
adoption of that summary establish continuation protection. Manual completion returns a
local zero-usage acknowledgement. The gateway does not create a separate summary request
or rewrite caller history. Native envelope compatibility and D14 joint acceptance remain
unverified.

## Tool Result Association

Claude-to-Gemini conversion tracks pending tool calls in history order. A tool result
consumes exactly one preceding call with its ID. Distinct IDs preserve parallel calls
with the same name and out-of-order results. Once consumed, an ID may be reused in a
later round without changing earlier responses. Generation-history admission separately
decides whether an unfinished exchange is a valid input; association alone does not authorize it.

An orphan or repeated result, a duplicate pending ID, or a tool block on the wrong
message role returns HTTP 400 with a position-only `invalid_request_error`. The gateway
does not invent a function name from an unmatched ID. Anthropic Messages rejects before
account selection; count-tokens rejects during conversion before leasing. OpenAI Chat
validates before account selection, and its mapper repeats the guard for direct conversion
callers. Responses preprocessing resolves each call's name at
its own history position, so a later reused ID cannot rename earlier calls or results.
A later incomplete custom call no longer suppresses an earlier completed round sharing
the ID. A complete leading call/result exchange is retained even without an earlier user
message. Function and custom outputs with no pending call fail rather than being dropped.
Responses session merging retains completed ID reuse and rejects duplicate pending calls
instead of deleting one. Result-only continuations repair calls against the complete parent
history; the retained child delta does not duplicate a call already owned by that parent.
Cached-call recovery considers only preceding history. It restores one unique cached
candidate; conflicting candidates fail with a position-only error instead of choosing by
array order or socket completion order. The socket retains a collision marker, and durable
cache arrays retain at most two distinct witnesses per call ID. Complete history remains
authoritative when present. Exact item-ID replays keep their first position; conflicting
item-ID payloads fail. Semantic replay comparison includes tool parameters and outputs,
and a repeated anonymous tool result alone is not a replay anchor.

Native Gemini binds each pending ID to its declared function name. A `functionResponse`
with the exact placeholder `unknown` inherits a known nonempty name only when its
explicit ID matches a preceding pending call. A missing ID does not authorize name
recovery. Other names must match, including when inheriting the sole pending call's
ID. Conflicts return HTTP 400 with `conflicting-result-name` and the part position
before account selection or generation. This check preserves complete result payloads,
deterministic IDs and sequential reuse after consumption; it does not execute or retry tools.

Responses fills missing tool-call IDs from a stable digest of complete preceding history,
normalized name and canonical arguments. Identical parallel calls still receive distinct
IDs because each call advances that digest. Supplied IDs remain unchanged. The generated
value is retained in the input delta before historical media is sanitized, so file restart
and result-only continuation keep the same association. A result without an ID is accepted
only when exactly one preceding call remains pending; otherwise it fails explicitly.
Fully identified histories bypass this hashing. The existing optional `call_id` field
and durable record format are retained; this does not reconstruct evidence removed by
compaction.

OpenAI Chat and native Gemini also generate IDs only for calls that arrive without one.
The digest includes preceding history, the normalized tool name, canonical arguments and
the call's position, so identical parallel calls stay distinct and a complete replay stays
stable. Supplied IDs remain unchanged, and the caller's request object is not mutated.
A result without an ID binds only when exactly one preceding call is pending; orphan,
duplicate-pending or ambiguous histories return HTTP 400 without guessing from the tool
name. OpenAI Chat checks this before account selection. Native Gemini checks both unary
and streaming generation before account selection. Fully identified histories do not hash
message or media content. Neither adapter retries, penalizes an account or dispatches an
upstream request for an invalid association.
See the [upgrade instructions](../../upgrade-guides/next/retain-tool-call-history.md).

Gemini-to-Claude, Gemini-to-Chat, and Gemini-to-Responses response adapters also preserve
upstream call IDs and deterministically fill missing ones. The ID includes a lazy digest of
the complete effective prompt history, model and tool declarations, followed by the call's
response position, name and canonical arguments. Stream flags and generated response IDs
do not participate in that digest.
Unary and streaming mappings use the same request-scoped identity, including synthetic
streams after unary generation. Identical parallel calls remain distinct; changing request
history or call data changes the ID. The request is hashed only when the first missing ID
needs generation, so complete upstream IDs avoid hashing message and media content. The
request copy is not rewritten. Adapters used directly without a service-provided request
scope use their available model/session or response context and therefore cannot provide
the service path's complete-history guarantee.

## Missing Thought Signatures on Tool Calls

Anthropic assistant messages with an explicit nonempty thinking or tool-use signature
preserve their text blocks exactly during request mapping. Whitespace-only blocks, the
literal `(no content)` and inline-image Markdown remain text; signed text does not undergo
trimming, placeholder removal or Markdown-to-image restoration. Media admission applies
the same distinction before mapping. Explicit image/document/audio/video blocks still pass
through media validation, and unsigned message normalization retains its existing behavior.
Signature presence is a preservation rule, not proof that the provider accepts that signature.

Thought Store recovery requires unique evidence inside the compatible model/session scope.
Explicit signatures take priority over unsigned history; unsigned matches use a unique
fingerprint or tool-ID candidate. Consumed candidates do not make an ambiguous ID unique.
Exact visible text is eligible only for a unique text record; prefixes and final-turn
category guesses are not recovery evidence. Multiple unsigned history turns claiming one
record remain unchanged. Hot capture, historical ingestion and SQLite save preserve
ambiguous records separately instead of overwriting the latest signed turn.

Thought Store schema 3 retains schema 2's per-part format: each thinking part's exact text range and signature,
and each function call's name, canonical argument digest, optional ID and signature.
Restoration requires a unique matching source and destination call; identical parallel
calls without distinct IDs remain unsigned. Independent signatures, including short
opaque values, are never ranked by length or copied from reasoning onto tools.
Empty reasoning parts and trailing whitespace retain their separate ranges. Supplied
meaningful signed text is not expanded by a cache hit. Hot capture, worker persistence,
history ingestion and cold hydration share this contract. Signature metadata consumes
the existing session, queue, memory and content-transfer budgets.

Schema 0/1 Thought Store tables are replaced transactionally on first open, without
import, automatic backup or old-format fallback, as explicitly approved. Unknown future
versions and databases containing unowned tables/views/triggers are refused. See the
[replacement and downgrade guide](../../upgrade-guides/next/replace-thought-store-history.md).

The in-memory tool-signature index also separates compatible physical-model families.
Different opaque values or different tool names captured under the same scoped call ID
invalidate automatic recovery until scope clearing, expiry or eviction. Signature length
and message count do not prove that values are fragments of one response. Recognized
raw/wrapped equivalents retain the first received bytes. A conflicting session/message
slot is a miss; generic lookup does not fall back from an ambiguous latest slot to an
older signature. Session/message slots are isolated by compatible model family, and
rewind only clears future slots for that model scope. Explicit request-local values remain
authoritative.

The Anthropic streaming mapper attaches signature-only parts to an already open thought
block, emits one correctly closed carrier and commits that block's latest complete value
when the block closes. It does not choose opaque values by length. A parse failure closes
the current thought block without committing its pending signature. Whole-response
commit and cleanup after transport failure remain governed by D11.

Missing tool-call signatures remain absent after exact scoped recovery. Claude request mapping does not invent a compatibility sentinel. Native Gemini mapping only completes the camel-case and snake-case aliases from a value the caller actually supplied, and does not generate a sentinel for Flash or pro-agent routes. The exact text `skip_thought_signature_validator` and its canonical Base64 representation are both treated as placeholders. Both follow the existing Gemini-only model check and are excluded from signature cache and Thought Store recovery. A saved placeholder is read as an absent signature while its thought and tool metadata remain available. If the provider requires a genuine signature and scoped recovery misses, the request follows the normal failure path.

Native Gemini generation rejects conflicting signature aliases before account selection. The service checks recognized Claude and Gemini signature formats against the routed target model. The check rejects known cross-family values, explicit placeholders on Claude targets, and recognized signatures for an unregistered target. The internal client repeats the check with the model actually sent upstream, including direct generation and warmup entry points. An explicit placeholder remains pass-through input for Gemini targets but is not treated as a real signature. Unknown opaque values are retained without inferring their family. These structural checks do not establish provider acceptance.

Native Gemini generation can continue an explicitly selected Claude model after a successful Gemini response in the same authenticated session. Evidence is scoped to the credential, explicit session hint and first-user anchor. The gateway keeps up to 1,024 recent session observations in memory for ten minutes. For a proven switch, it removes recognized Gemini signatures and placeholders from model history and omits the private thought-only parts that carry them. Visible text, tool calls and tool results remain in the request. The history supplied by the client remains intact. Requests without matching evidence follow the existing signature checks.

Every in-memory thought signature produced by a real upstream response carries its normalized physical model and, when the model registry can establish one, its canonical family. A supplied family hint is trusted only when its associated physical model is the model actually sent upstream; mapper rewrites such as the web-search fallback discard a stale pre-mapper family and resolve from the final physical model. Cache reads require the target effective model: known families may reuse signatures only inside the same canonical family, while unregistered models require an exact normalized physical-model match. Entries without provenance are cache misses. OpenAI-compatible responses record the effective upstream model rather than the client-visible response model.

The Anthropic compatibility owner handles one narrowly classified upstream HTTP 400 per account attempt. Recognition prefers explicit structured signature details, then the upstream message, then parsed error JSON, with a final exact `Invalid thought signature` text fallback. Generic invalid-signature, deserialization, thinking-block and `INVALID_ARGUMENT` errors remain on the ordinary error path; the provider-neutral retry classifier is unchanged.

Recovery clears only the current session signature scope (or only the legacy unsessioned scope), clones the original account-specific Claude request, converts non-empty historical thinking blocks to text, removes empty and redacted thinking blocks, retains explicit tool-use signatures, and appends the fixed recovery prompt only to a final user message. A broken trailing tool-result loop receives the required assistant/user closure pair; an interrupted tool call receives the assistant closure immediately after the tool-use turn. Already closed loops receive no synthetic turns.

The repaired request is mapped through the normal mapper pipeline in recovery mode, which performs no signature-cache reads and does not generate a sentinel. It is retried immediately once with the same account, token and effective physical model, without delay, penalty or account rotation. A second classified signature 400 is propagated without a third attempt. Streaming recovery applies only while establishing the upstream stream; once a stream has been returned and response events can be emitted, later stream errors are never replayed.

## Anthropic Empty Response Recovery

An Anthropic non-stream response always contains at least one content block. If the upstream response and its stream-aggregation fallback contain no text, thinking, tool use, image-derived text, grounding output or signature, the response mapper returns one text block containing `.` while preserving the normal stop reason and usage.

The streaming path applies the same compatibility rule only at normal stream termination. When no meaningful thinking or content was emitted, it reuses an existing `message_start` or creates one with the normal message-ID generator and model `gemini-auto`, then emits `content_block_start` with `text: "."`, `content_block_stop`, an `end_turn` `message_delta` with one input and one output token, and `message_stop`. The recovery block has no `text_delta`. Upstream stream errors remain errors, empty native Gemini streams remain errors, and an empty thought without a signature does not suppress this fallback.

## Anthropic Tool-Call Leakage Recovery

The Anthropic adapter recovers an upstream text block shaped exactly as `call:default_api:<tool>{...}` only when `<tool>` matches a tool registered on the current request, case-insensitively. The emitted `tool_use` uses the request's canonical spelling. Missing arguments become `{}`. Unary responses require a strict JSON object; streaming first accepts strict JSON and then retries after quoting bare object keys, following the protocol-specific parser contract.

Recovery is fail-closed. It is disabled when the request has no tools, the text contains surrounding prose, the name is not on the request whitelist, arguments are not an object, or the stream has already emitted an ordinary text delta or a structured tool call. A rejected candidate remains ordinary text. Successful streaming recovery is routed through the existing function-call event path so block order, argument deltas, IDs and the final `tool_use` stop reason stay consistent with native upstream calls.

Every Anthropic streaming `message_start.message` includes `usage`. Upstream values take precedence, an explicit caller fallback is next, and otherwise the event contains exactly zero input and output tokens. Final `message_delta` usage remains unchanged.

## OpenAI Chat Video Inputs

An OpenAI Chat Completions content block shaped as `{"type":"video_url","video_url":{"url":"..."}}` follows the gateway's compatibility source order. A `data:` URL becomes Gemini `inlineData`; an HTTP(S) URL becomes `fileData`; an existing local path or `file://` URL is read and Base64-encoded into `inlineData`; every other non-empty string is treated as raw Base64. `mime_type`, `mimeType`, and `format` are equivalent MIME hints. Known video extensions normalize to the corresponding Gemini MIME type and unknown extensions fall back to `video/mp4`. Payloads estimated above 20 MiB are warned about but remain eligible to preserve the documented compatibility behavior.

Local path and `file://` reads occur only while `proxy.experimental.allow_local_video_paths` is enabled. The setting defaults to false, persists in the normal application configuration and is observed by a running gateway without restart. Disabled mode performs no filesystem probe or read: explicit local path forms are dropped from an ordinary message and become `[video]` inside a tool result, while ambiguous non-URL strings retain the raw-Base64 fallback. If dropping the local source would otherwise erase a user turn, the Gemini request preserves that turn with one whitespace text part so user/model role rotation remains valid. Data URLs, HTTP(S) URLs and raw Base64 do not depend on this setting.

## OpenAI Model Listing Metadata

`GET /v1/models` and `GET /v1/models/{id}` publish the standard OpenAI identity fields and add
the request budget an OpenAI-compatible client needs to size a conversation:

- `context_length` is the model's input window. `src/modules/proxy-gateway/antigravity/model-specs.ts`
  owns the registered value; an id the catalog does not contain falls back to its family width
  (Gemini 1,048,576, Claude 200,000) and then to 128,000.
- `max_completion_tokens` is the output cap the gateway enforces for the model, read from the
  same catalog and defaulting to 65,535.

A user alias advertises the limits of the model it routes to rather than the alias name, so a
client budget derived from the listing matches the upstream call. Both routes use one entry
builder, so `GET /v1/models/{id}` returns exactly the object the list published.

## Responses Requests and Durable History

Chat Completions also accepts a Responses request body when `messages` is absent and
`input`, `instructions` or `previous_response_id` is present. This compatibility entry
validates a string or item-array input and reuses Responses preparation for instructions,
roles, tool IDs, media and owned previous history. Malformed input returns 400. Missing or
foreign previous response IDs return 404 before account execution. A supplied `messages`
field selects the regular Chat path.

The compatibility entry returns Chat completion objects or Chat SSE chunks, including
`stream_options.include_usage`. Explicit `store: true` uses the Chat completion GET store.
Streamed Chat storage retains its existing 400. A compatibility call can read a retained
Responses parent but creates its new stored answer only through the Chat storage rule.
The returned Chat ID belongs to the Chat surface and cannot address a new Responses node.

Role-bearing messages with a missing or non-string `type` use the message path. Explicit empty-string and unknown string types are ignored as whole input items. Non-string roles default to `user`. String roles are retained through input parsing; the shared downstream conversion treats `system` and `developer` as instructions, keeps `assistant` and tool semantics, and degrades every other string role to `user` instead of forwarding an unknown Gemini role. Array content and a single typed object collect every string `text`, including empty strings, join them with newlines, and then append validated image or supported audio blocks. Both `input_image` and `image_url` accept a URL string or a validated URL object. URLs must be non-empty strings, `detail` must be `auto`, `low` or `high`, and other JSON extensions are retained. Supporting the object form for `input_image` is an intentional compatibility extension beyond upstream. Malformed image blocks are ignored rather than forwarded unchecked. `audio_url` accepts a URL object with optional `mime_type`, `mimeType`, or `format`: data URLs become Gemini `inlineData`, HTTP(S) URLs become `fileData`, and an unreadable tool-result source becomes the protocol-compatible `[audio]` text fallback. An untyped JSON object contributes no text; the enclosing message remains available to the existing cleanup rules. Top-level input objects and primitive content retain their existing conversion behavior.

Function and custom-tool outputs unwrap an enclosing `content` field, accept an array or one typed object, keep text and supported image/audio media together, and retain the prior JSON-string fallback only when no supported part was recognized. The apply-patch retry-loop compactor runs on the extracted text without discarding media. Downstream mapping emits Gemini `functionResponse` first and then media `inlineData`; a pure-media result keeps an empty function result instead of fabricating success text.

Raw history and input parsing share their type resolver. Native `reasoning` output items,
`msg_thought_` IDs and the reserved thinking prefix identify transcript-only items.
`phase: commentary` alone does not discard genuine assistant content. Filtering precedes
compaction, merging, call repair and deduplication. Leading tool exchanges follow the
[association rules](#tool-result-association). Input conversion preserves terminal assistant
roles and leaves an empty history empty; [generation admission](#generation-history-admission)
owns prefill and invalid histories.

Valid historical media remains available by default. The optional image send window
operates on a restored request copy and does not erase retained originals. File-backed
sessions keep private media references, including exact image-bearing tool text, instead
of copying inline payloads into session JSON. Argument values and unrelated metadata
are not media slots. See [media admission, windows and durable recovery](inline-media-and-thought-history.md)
for budgets, reference versions, missing-content errors and downgrade limits.

The remaining ignore rules apply to new input and recovered history during request conversion without rewriting old GET payloads. An empty-type assistant item does not trigger WebSocket transcript replacement. File-reference resolution still precedes input conversion, so unresolved attachment references retain their existing errors even inside an otherwise ignored item or object content.

Non-stream responses emit nonblank reasoning as `reasoning` items with `summary_text`, followed by visible text/refusal and tools. Streaming emits the same native reasoning item shape, with the lifecycle `response.reasoning_summary_part.added` → `response.reasoning_summary_text.delta` → `response.reasoning_summary_text.done` → `response.reasoning_summary_part.done` → `response.output_item.done`. It closes reasoning before visible text or a tool item and never emits `output_text` or `content_part` events for reasoning. Ordinary message and tool lifecycles are unchanged, while native reasoning remains in the completed response but is excluded from continuation replay. Non-stream ordinary message items have no `phase`; streaming ordinary messages retain their existing `commentary` or `final_answer` phase. The apply_patch diagnostic exception retains commentary. Zero cached/reasoning token detail fields are normalized only at the non-stream response boundary.

The production non-stream path selects the first Gemini candidate, concatenates its text blocks without a separator, and constructs one internal Chat Completions choice with string-or-null content and a usage object. Missing upstream usage becomes zero before the final Responses conversion. The non-stream stream-aggregation fallback uses the same normalization. The final Responses mapper is not a general-purpose converter for arbitrary external Chat Completions responses or multiple choices.

When image content is present, the Responses-to-chat conversion omits a text block only when the newline-joined text is exactly empty. It does not trim the joined text: spaces and newlines remain explicit text content. This matches the upstream parser's empty-text boundary without broadening normalization.

Response IDs, function/custom tool IDs, namespaces and call IDs are preserved. Old stored response payloads are replayed unchanged by GET. Exact and semantic full-history replays, shared item IDs, and semantic tail matches select only the new suffix; if an unmatched client history is at least as long as the stored history, the client history is authoritative instead of being appended again. Semantic matching ignores volatile IDs but requires equal role, type and content, using text only when content is absent.

Responses account routing and signature provenance are separate. A nonblank request `session_id` overrides the stored lineage routing identity; otherwise continuations inherit it, fall back to `previous_response_id`, and roots use the new response ID. Account leasing uses only that routing identity. Tool signatures are still read from the parent response ID and written under the new response ID. The routing identity is stored on each retained node; legacy records without it use their addressed response ID.

Only explicit `store: false` disables storage. The request may reconstruct and use a valid parent's history, instructions, model, tools and cached calls for the current upstream call, but the returned response creates no retrievable payload or continuation node. A later GET or `previous_response_id` using that transient response ID returns 404. Omitted and true storage retain the completed turn. The durable record format remains version 1 with the existing one-hour TTL, 500-session limit, missing-ID errors and deletion semantics. Recovery requires an entry retained within those limits and a completed disk flush; this is not a guarantee for interrupted writes or incomplete streams.

The traffic-audit and Thought Store switches are application-level persistence controls and are
independent of the OpenAI `store` field. A Responses request with `store: false` still participates
in traffic auditing and, when it provides a stable session identifier, thought restoration. The
same hashed credential plus sanitized client session identifier selects a Thought Store session
across OpenAI Chat/Responses, Anthropic Messages and Gemini generate/stream entry points. Requests
without a stable identifier receive a per-request key and never restore another request's thought.

Historical model turns are ingested against the entire stored session, not only its last record.
Repeated client history does not append duplicate unambiguously matched turns; stronger
reasoning or additional owned signatures can enrich a matching record. Restoration uses
the unique model/session and part-ownership evidence described above, with no final-turn
category fallback. Complete signed text is left unchanged, and text/tool turns do not cross-match.

Successful OpenAI Chat, Responses and Completions requests and native Gemini generate requests
include `X-Session-Id`, `X-Antigravity-Session-Id` and `X-Timing-Version: 2`. Measured
stages use `X-Timing-Clean-Ms`, `X-Timing-Norm-Ms`, `X-Timing-Thinking-Ms` and
`X-Timing-Ttft-Ms`; unmeasured stages are absent, while measured zero is retained. The
session headers identify the client-visible routing session, not the hashed Thought Store key.
Streaming responses emit these headers when the first output is ready so TTFT is measured from
the upstream start to its first response byte. Timing is diagnostic and does not gate the model
response.

## System Instruction Role Normalization

Every existing internal Gemini `systemInstruction` reaches the upstream wire with `role: "user"`. Normalization runs after each OpenAI Chat, Responses, Anthropic, or native Gemini mapper has constructed its internal request, so only the role changes; instruction parts, tool configuration, safety settings, generation configuration, contents, and model routing are preserved. A request with no system instruction remains without one. Count-token paths continue omitting system instructions. Protocol and image paths that already remove an instruction keep doing so; native Gemini image requests that already carry a system instruction retain it and apply the same `role: "user"` normalization. Explicit context caching therefore observes the same normalized request shape as direct generation.

## Tool Configuration and Explicit Context Caching

OpenAI function tools produce both camelCase and snake_case configurations. Anthropic mapped tools produce both aliases and retain explicit tool-choice modes. Native Gemini requests containing `tools`, including an empty array, preserve each valid supplied configuration and add its invocation-reporting flag. A missing configuration receives `VALIDATED`; an existing empty object receives only the flag. Without tools, supplied configurations remain unchanged. Malformed configuration aliases or a non-array `tools` value return a client error before account selection; they are not forwarded unchanged to the provider.

Mapped function declarations exclude automatic Google Search injection. Native Gemini declarations are not globally filtered by that mapping rule.

Equivalent, known tool configurations use the existing canonical cachedContents request. Conflicting aliases, snake-only configurations and unrepresented extensions bypass explicit caching. Cache identity covers the represented mode, allowed names, flag values and field presence. A cache-backed generation request omits tools, both configuration aliases and system instructions. Cache creation failure or cache rejection restores the full original generation body.

## Verification

The upgrade fixture in `src/tests/fixtures/responses-format-v1` was written before the format change. The unit suites cover protocol normalization, old-session recovery, controller errors and actual HTTP serialization against a synthetic loopback upstream. These are regression evidence, not live-provider evidence. See [testing.md](../../testing.md) for validation scope and the [decision record](../../../.agents/notes/implemented/bug-fix/2026-08-30-responses-history-compatibility.md) for deliberate compatibility boundaries.

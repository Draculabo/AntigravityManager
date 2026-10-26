# Inline media admission and thought history

This reference describes admission for ordinary OpenAI Chat and Anthropic Messages,
including Anthropic `count_tokens`, nested tool results and Markdown images recognized
by the request mapper. Responses converted through the Chat service also pass admission.

## Media admission

Admission precedes account selection and upstream execution. Empty, malformed or
noncanonical Base64 and invalid data URL metadata return HTTP 400. These errors identify
the media category without including encoded bytes. A rejected request creates no upstream
attempt and does not rotate accounts.

Recognized file signatures determine MIME within the declared media family. For example,
PNG bytes declared as JPEG become `image/png`, with the original bytes preserved. Recognized
content from another family is rejected rather than replaced with text. M4A audio retains
`audio/mp4` only when an audio container brand is present. Text-like documents keep their
specific declared MIME. Unknown binary signatures retain the declared MIME; this check
does not prove that an entire image, PDF or codec stream can be decoded by the provider.

All inline images in one request share the existing image-generation limits: at most
16 images, 20 MiB decoded per image and 32 MiB decoded in total. Images inside tool results,
documents declared as images and recognized Markdown images share that budget. OpenAI
`input_audio` retains its existing 15 MiB limit. Other audio, video and document inputs
retain the existing transport limits rather than adopting new per-file limits.

Remote URL behavior and local video-path configuration remain owned by their existing
resolvers. Admission does not fetch remote resources or enable local file access. Markdown
that the mapper does not recognize as an inline image remains text. System instructions and
tool-result prose keep their existing text representation; Markdown syntax in those positions
does not become an image or consume the image budget.

## Durable Responses media

File-backed Responses history keeps protocol media bytes in the private
`openai-responses-media` content store instead of copying Base64 or data URLs into
`openai-responses-sessions.json`. The session file contains a versioned reference with the
content ID and enough metadata to restore the original representation. This namespace has no
public Files handle or route. It reuses the content store's content-addressed deduplication,
20 MiB per-item limit, 512 MiB total limit and 48-hour expiry.

Only recognized Responses image and audio fields are externalized. This includes message
media, `audio_url`, and structured media returned in tool-result output. Data URLs embedded in
`function_call` or `custom_tool_call` arguments remain ordinary tool input and are not rewritten.
A client cannot supply the internal reference marker; malformed references are rejected before
they enter trusted history.

Reading a stored input or completed response restores the original bytes and refreshes the
private item's expiry. If an item has expired or its content is missing, HTTP read or continuation
returns 410 with instructions to start a new conversation or resend the media. Deleting a stored
response only requires the caller-owned session record and remains possible after its media has
expired.

Streaming publishes `response.completed` only after a write containing media references reaches
the backing session file. A storage failure terminates the stream with the sanitized Responses
persistence error and is not retried. Non-streaming success follows the same commit rule. Records
created before this private-media format are discarded by the strict session decoder; there is no
media migration, compatibility reader or encryption layer. Old cursors therefore require a new
conversation, while clients may resend history they still hold.

## Thought history

Thought capture skips records containing neither meaningful thought text nor a real
provider signature. The provider sentinel and unsigned `.`, `...`, Unicode ellipses and
other recognized placeholders do not create thought records. A real signature is retained
even when its thought text is a placeholder, so later tool history can restore it.

Restoration upgrades matching tool history from a sentinel to a real signature while
preserving tool IDs, names and argument objects. Complete signed history is not replaced.
Disabling new thinking generation at the mapper does not remove existing history signatures.
Public gateway model profiles and direct Gemini agent routes retain their existing
server-authoritative thinking budget policy; a client `thinking.type: disabled` request
does not override that policy.

Every warm restore refreshes the in-memory access time. SQLite access writes are coalesced
per session over a five-minute interval, measured with a monotonic clock. Successful queue
admission for a record save or history ingest also starts that interval; hydration already
refreshes SQLite access time. Queue rejection does not advance the interval, and an
asynchronous failure invalidates only its own access marker. The next restore can attempt
the access write again; model execution does not wait for this background write.

The durable access timestamp can lag the last in-memory access by up to five minutes when
the queue is healthy. A crash or restart near the retention cutoff can therefore expire a
session slightly earlier than its last in-memory access suggests. Retention settings, the
SQLite schema and thought record encoding remain unchanged. This optimization reduces
access writes, not record saves, and does not recover a failed thought-record save.

## Complete context observation

Internal content generation estimates semantic input after thought restoration and before
explicit context caching removes system instructions and tool declarations from the wire
request. The estimate includes system text, complete tool definitions, message text,
restored thoughts, function arguments and results, signature metadata and inline media.
Routing IDs and output/thinking reservations are not input context. Token counting retains
its separate path. Weekly warmup receives physical-send observation without adding history
restoration or a new generation attempt.

Each typed internal generation dispatch emits one `[ContextEstimate]` debug diagnostic
after final attempt rebinding and serialization. `semanticEstimate` retains the full
pre-cache input; `sentEstimate` describes the request body actually dispatched. A cached
prefix is identified separately, so a smaller wire estimate cannot be mistaken for a
smaller semantic input. Cache rejection, regional failover and admitted recovery have
their own physical-send records. `serializedBytes` is the UTF-8 length of the exact JSON
string used by unary and streamed request bodies. `attempt` uses the existing request
attempt sequence, or is null without a trusted request context. Raw passthrough and
count-token operations do not enter this typed generation diagnostic.

The diagnostic contains numeric totals, component counts and bounded transformation
metadata; it does not log prompt text, signatures, encoded media, URLs or credentials. Text uses
ASCII/non-ASCII character heuristics with a margin. Image cost is approximated from size;
audio uses a PCM size approximation that cannot recover compressed-audio duration.
PDFs, video, other binary data and remote media increment `unestimatedMediaParts` instead
of presenting a fabricated token count. Their inline byte counts remain visible.

Transformation metadata records a closed kind, owning surface and zero-based message/part
position. A null position means that level does not apply. System positions refer to the
system mapper's input blocks; message and content positions refer to the named mapper
surface at the time of transformation. It covers owned billing removal, identity changes,
initial-system promotion, late reminders, configured global sections, empty text removal,
prefill tails and recognized signature wrapping. It retains at most 64 entries per request,
reports additional entries as a dropped count, and isolates concurrent requests through
the existing request context. Preparation that changes nothing adds no event. This is
metadata about transformations, not an original/transformed payload viewer; consent and
redaction for body inspection remain with the traffic-audit owner.

These values are approximate diagnostics, not a provider tokenizer result or a reliable
model input window. The gateway does not reject or compress history based on them and
does not replace provider-reported usage. A model-list compatibility value is not used
as an admission limit.

## Verification

`proxy-inline-media-admission.test.ts` exercises the production protocol services before
leasing and tests request-wide image limits and MIME normalization. Thought capture and
restoration tests cover unsigned placeholders, signature-only records, sentinel upgrades
and signed tool history. Access-write tests cover warm replay, the five-minute boundary,
queue rejection and asynchronous failure ordering. Context tests cover complete components
and observation before cached-prefix removal. Native acceptance checks HTTP/SSE, SQLite thought persistence,
audit categories and upstream attempt counts. Live-provider acceptance separately checks
image input, signed tool responses and continuation with a synthetic tool result.

See [the testing strategy](../../testing.md) for the distinction between deterministic tests,
native runtime checks and live-provider evidence. No client-side tool execution is required
for these protocol checks.

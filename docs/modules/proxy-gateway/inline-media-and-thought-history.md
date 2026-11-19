# Inline media admission and thought history

This reference describes admission for OpenAI Chat, Responses, Anthropic Messages and
native Gemini, including token counting, nested tool results and Markdown images recognized
by the request mapper. Image generation and multipart edit inputs use the same image checks.

## Media admission

Admission precedes account selection and upstream execution. Empty, malformed or
noncanonical Base64 and invalid data URL metadata return HTTP 400. These errors identify
the media category without including encoded bytes. A rejected request creates no upstream
attempt and does not rotate accounts.

Recognized file signatures determine MIME within the declared media family. For example,
PNG bytes declared as JPEG become `image/png`, with the original bytes preserved. Recognized
content from another family is rejected rather than replaced with text. M4A audio retains
`audio/mp4` only when an audio container brand is present. Text-like documents keep their
specific declared MIME. Explicit images require a recognized PNG, JPEG, GIF, WebP or BMP
signature and minimum container structure. Unknown binary, header-only and truncated images
return HTTP 400 before leasing. This does not decode pixels or establish codec correctness;
PNG CRCs and compressed payload validation remain the decoder's responsibility. Other unknown
binary media retain their declared MIME under their existing audio/video/document contracts.

All inline images in one request share the existing image-generation limits: at most
16 images, 20 MiB decoded per image and 32 MiB decoded in total. Images inside tool results,
documents declared as images and recognized Markdown images share that budget. OpenAI
`input_audio` retains its existing 15 MiB limit. Other audio, video and document inputs
retain the existing transport limits rather than adopting new per-file limits.

Remote URL behavior and local video-path configuration remain owned by their existing
resolvers. Admission does not fetch remote resources or enable local file access. Markdown
that the mapper does not recognize as an inline image remains text. System instructions keep
their literal text representation. Tool results recognize standalone image data URLs, Markdown
images outside code fences, and string data URLs in the JSON top-level fields `image`,
`screenshot`, `data`, `image_url` and `picture`. JSON parsing is bounded to the maximum
aggregate image Base64 representation plus 64 KiB of metadata; larger tool text stays text.
Other JSON fields, nested examples and data URLs inside ordinary log lines are not extracted.

Tool-text image extraction rejects invalid candidates without removing their original text,
and records only a bounded request-local diagnostic kind. Accepted tool images join the same
request-wide count/byte budget before leasing. Extracted image bytes are not copied into
these diagnostic entries.
Function-call arguments remain opaque even when an object inside them resembles an image block.

## Image send window

Gateway settings → Upstream network and experiments provides a disabled-by-default image history window. Count retains
the newest images up to N, including current images; 0 removes this soft count limit.
Every current image remains protected, so current images above N leave no historical
slots. The count strategy does not apply the memory strategy's soft budget. Remote
images join count selection only when enabled, and current remote images stay protected.

For Responses full-transcript replay, the latest user message and all subsequent
tool results form the protected current operation. Earlier screenshots participate
in the configured history window even when they arrive in the same HTTP body.
Without a user message, the supplied tool results remain protected. Identical images
in separate turns are matched as separate occurrences. The Responses and mapped
Gemini windows preserve the same current user-and-tool boundary.

Each submitted structured inline image is validated before window selection, with
the 20 MiB single-image ceiling. The protected operation and the final send retain
the 16-image and 32 MiB aggregate ceilings. The optional memory-window limit returns
HTTP 400 for an oversized protected operation. Window omission changes only the
outbound copy, including the supported object form of an `input_image` URL.

The separate memory strategy retains the newest continuous historical suffix within its
exact decoded-file-byte budget. Current inline images above that budget fail explicitly.
It ignores the count preference and retains remote URLs, whose file size is unknown.
Neither strategy downloads remote content, relaxes admission limits, decodes pixel memory,
deletes persisted originals or rewrites tool arguments. Switching off or increasing the
window can reuse originals that remain within the private store's retention contract.

Configuration without `send_window_strategy` resolves to `count`. The new explicit
strategy replaces the earlier controlled implementation's combined soft limits; see
the [upgrade guide](../../upgrade-guides/next/strict-inline-images.md).

## Image output failures

The OpenAI image generation and edit endpoints return a stable error code when
an upstream generation result contains no usable image. An explicit provider
policy marker returns HTTP 400 with `image_policy_blocked`. Text-only output,
an empty candidate list, and a candidate with missing image data return HTTP 502
with `image_text_only`, `image_empty_response`, and `image_missing_data`, respectively.
The public message contains only a fixed gateway description. Existing provider
transport and HTTP errors retain their normal handling and audit controls.

## Durable Responses media

File-backed Responses history keeps protocol media bytes in the private
`openai-responses-media` content store instead of copying Base64 or data URLs into
`openai-responses-sessions.json`. The session file contains a versioned reference with the
content ID and enough metadata to restore the original representation. This namespace has no
public Files handle or route. It reuses the content store's content-addressed deduplication,
20 MiB per-item limit, 512 MiB total limit and 48-hour expiry.

Recognized Responses image and audio fields are externalized. This includes message
media, `audio_url`, and structured media returned in tool-result output. Image-bearing
tool-output strings and text blocks recognized by the same standalone/JSON/Markdown policy
are stored as exact JSON-encoded strings in private chunks. The version-2 text reference
contains chunk IDs, byte count and SHA-256; at most four 16 MiB chunks (64 MiB serialized
text) are admitted. All chunks consume the existing aggregate disk/expiry policy. Missing,
altered or malformed text references produce the same 410 as unavailable protocol media.
Data URLs embedded in
`function_call` or `custom_tool_call` arguments remain ordinary tool input and are not rewritten.
A client cannot supply the internal reference marker; malformed references are rejected before
they enter trusted history.

Reading a stored input or completed response restores the original bytes and refreshes the
private item's expiry. If an item has expired or its content is missing, HTTP read or continuation
returns 410 with instructions to start a new conversation or resend the media. Deleting a stored
response only requires the caller-owned session record and remains possible after its media has
expired.

Concurrent operations on a newly opened content store wait for the same index load and startup
cleanup. A second cold read cannot observe the not-yet-loaded in-memory index as an empty store.

Streaming publishes `response.completed` only after a write containing media references reaches
the backing session file. A storage failure terminates the stream with the sanitized Responses
persistence error and is not retried. Non-streaming success follows the same commit rule. Records
created before this private-media format are discarded by the strict session decoder; there is no
media migration, compatibility reader or encryption layer. Old cursors therefore require a new
conversation, while clients may resend history they still hold.

Version-1 image/audio references remain readable. Older versions cannot restore the new
version-2 tool-text references; follow the [downgrade instructions](../../upgrade-guides/next/responses-tool-media.md).

## Thought history

Thought capture skips records containing neither meaningful thought text nor a real
provider signature. The provider sentinel and unsigned `.`, `...`, Unicode ellipses and
other recognized placeholders do not create thought records. A real signature is retained
even when its thought text is a placeholder, so later tool history can restore it.

Restoration upgrades matching tool history from a sentinel to a real signature while
preserving tool IDs, names and argument objects. Complete signed history is not replaced.
Disabling new thinking generation at the mapper does not remove existing history signatures.
Explicit `store: false` Responses requests use the bounded in-memory signature cache
for complete client-owned transcripts, scoped by credential, initial task and client
session hint. A transient request that explicitly addresses a stored parent reads that
parent's signature scope. Stored Responses retain their response-ID signature scopes.
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

When recent memory cannot match older turns, the Thought Store Worker selects the
session's causal candidates in one query. It checks record counts and the aggregate
stored-byte budget before loading candidate bodies in one batch. Candidate order
follows the request's distinct anchors and ascending record IDs within each anchor.
More than 64 records for one anchor, 256 records overall, or 64 MiB of stored
content and metadata fails the lookup before loading any candidate body. Returning
only part of a candidate set could hide an ambiguity.

Request-local restore diagnostics use fixed counters in the existing audit context.
Signature-cache hits and misses count tool-signature lookups. Store hits count turns
whose outbound parts actually changed after ownership checks. A loaded memory result,
or memory used without a successful persistent read result, counts as a memory hit.
A fresh persistent read without current memory records counts as a cold hit. When
nonempty persistent and current record sets merge, restored turns count as
`restoredSourceUnknown`. This conservative classification applies to the whole merged
result, including older-history lookups; persisted IDs do not establish content origin.
Complete supplied history adds no hit.
An owned candidate that changes nothing has a separate `matchedUnchanged` counter.

`noCandidate` means completed lookups left the current compatible record set empty for
a turn that needs restoration. An unmatched turn with compatible records counts as
`unresolved`, because the matcher does not distinguish absence from ambiguity or
competing ownership claims. Admission failures, read failures and active failure
cooldowns have separate counters. A missing candidate after any such unavailable
lookup also counts as `unresolved`. Cancellation and invalidation have their own
counters. These outcomes do not infer global absence, expiry or deletion. Shared cold
reads deliver the same availability and source classification to every waiting request.
Counters accumulate over existing retries and contain no history, signatures or tool identities.

The existing `[ContextEstimate]` debug output includes a `thoughtRestore` snapshot on
physical sends and at `thought-restore-complete`. The completion record covers cancelled
or invalidated preparation that never dispatches. Records include the audit request ID
when capture supplies one. The counters are diagnostic log metadata; they are not stored
in the audit database or displayed in the thought management UI.

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

The diagnostic contains numeric totals, component counts, `algorithmVersion` and bounded
transformation metadata. Text uses ASCII/4 and non-ASCII/2.2, rounded per nonempty block
with a minimum of one. Image cost is approximated from size. Version 2 treats audio
without verified duration, PDFs, video, other binary data and remote media as unknown.
These parts increment `unestimatedMediaParts` and retain their inline byte counts.

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

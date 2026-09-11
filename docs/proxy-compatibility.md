# Proxy Compatibility Reference

## Claude Agent SDK Client Identity

Claude request mapping normalizes the exact top-level Claude Agent SDK identity sentence to the Claude Code identity before cache sanitization. The rule applies to a string `system` value and to matching text blocks in a top-level `system` array. It is intentionally exact: mentions inside longer text, whitespace-padded variants, and embedded role-bearing system messages remain unchanged.

The normalized Claude Code text remains a client customization rather than an official-provider identity marker. The mapper therefore retains the Antigravity fallback identity alongside it, preserving the existing cache and provider-routing contract.

## Missing Thought Signatures on Tool Calls

Claude request mapping injects the compatibility sentinel for an unsigned tool call when thinking is enabled **or** the mapped model keeps unsigned thinking history (Gemini Flash or pro-agent). Resource-style `projects/` models are excluded from this fallback. Available real signatures and existing cache precedence remain authoritative.

Native Gemini request mapping completes the camel-case and snake-case signature aliases without mutating caller history. An existing alias supplies the missing alias. Only a model name containing both `gemini` and `flash`, case-insensitively, receives the sentinel when neither alias exists. Native pro-agent requests do not inherit the Claude-only allowance. This route does not add a new session-signature cache. Streaming and non-streaming requests share the envelope conversion.

Every in-memory thought signature produced by a real upstream response carries its normalized physical model and, when the model registry can establish one, its canonical family. A supplied family hint is trusted only when its associated physical model is the model actually sent upstream; mapper rewrites such as the web-search fallback discard a stale pre-mapper family and resolve from the final physical model. Cache reads require the target effective model: known families may reuse signatures only inside the same canonical family, while unregistered models require an exact normalized physical-model match. Entries without provenance are cache misses. OpenAI-compatible responses record the effective upstream model rather than the client-visible response model.

The Anthropic compatibility owner handles one narrowly classified upstream HTTP 400 per account attempt. Recognition prefers explicit structured signature details, then the upstream message, then parsed error JSON, with a final exact `Invalid thought signature` text fallback. Generic invalid-signature, deserialization, thinking-block and `INVALID_ARGUMENT` errors remain on the ordinary error path; the provider-neutral retry classifier is unchanged.

Recovery clears only the current session signature scope (or only the legacy unsessioned scope), clones the original account-specific Claude request, converts non-empty historical thinking blocks to text, removes empty and redacted thinking blocks, retains explicit tool-use signatures, and appends the fixed recovery prompt only to a final user message. A broken trailing tool-result loop receives the same assistant/user closure pair used by the production competitor; an interrupted tool call receives the assistant closure immediately after the tool-use turn. Already closed loops receive no synthetic turns.

The repaired request is mapped through the normal mapper pipeline in recovery mode, which performs no signature-cache reads but retains sentinel behavior. It is retried immediately once with the same account, token and effective physical model, without delay, penalty or account rotation. A second classified signature 400 is propagated without a third attempt. Streaming recovery applies only while establishing the upstream stream; once a stream has been returned and response events can be emitted, later stream errors are never replayed.

## Responses Requests and Durable History

Role-bearing messages with a missing or non-string `type` use the message path. Explicit empty-string and unknown string types are ignored as whole input items. Non-string roles default to `user`. String roles are retained through input parsing; the shared downstream conversion treats `system` and `developer` as instructions, keeps `assistant` and tool semantics, and degrades every other string role to `user` instead of forwarding an unknown Gemini role. Array content collects every string `text`, including empty strings, joins them with newlines, and then appends validated image blocks. Both `input_image` and `image_url` accept a URL string or a validated URL object. URLs must be non-empty strings, `detail` must be `auto`, `low` or `high`, and other JSON extensions are retained. Supporting the object form for `input_image` is an intentional compatibility extension beyond upstream. Malformed image blocks are ignored rather than forwarded unchecked. Non-array JSON object content contributes no text; the enclosing message remains available to the existing cleanup rules. Top-level input objects, tool outputs and primitive content retain their existing conversion behavior.

Raw history and input parsing share their type resolver. Assistant `phase: commentary`, `msg_thought_` IDs, and the reserved thinking prefix identify transcript-only messages. Filtering precedes compaction, merging, call repair and deduplication. The existing leading-orphan cleanup, terminal assistant-prefill rewrite, and empty-user fallback remain in place.

The ignore rules apply to new input and recovered history during request conversion without rewriting raw stored items or old GET payloads. An empty-type assistant item does not trigger WebSocket transcript replacement. File-reference resolution still precedes input conversion, so unresolved attachment references retain their existing errors even inside an otherwise ignored item or object content.

New non-stream responses emit nonblank reasoning as `reasoning` items with `summary_text`, followed by visible text/refusal and tools. Ordinary message items have no `phase`. The apply_patch diagnostic exception retains commentary. Streaming retains its existing commentary messages and event sequence. Zero cached/reasoning token detail fields are normalized only at the non-stream response boundary.

The production non-stream path selects the first Gemini candidate, concatenates its text blocks without a separator, and constructs one internal Chat Completions choice with string-or-null content and a usage object. Missing upstream usage becomes zero before the final Responses conversion. The non-stream stream-aggregation fallback uses the same normalization. The final Responses mapper is not a general-purpose converter for arbitrary external Chat Completions responses or multiple choices.

When image content is present, the Responses-to-chat conversion omits a text block only when the newline-joined text is exactly empty. It does not trim the joined text: spaces and newlines remain explicit text content. This matches the upstream parser's empty-text boundary without broadening normalization.

Response IDs, function/custom tool IDs, namespaces and call IDs are preserved. Old stored response payloads are replayed unchanged by GET. The durable record format remains version 1 with the existing one-hour TTL, 500-session limit, missing-ID errors, deletion and `store: false` semantics. Recovery requires an entry retained within those limits and a completed disk flush; this is not a guarantee for interrupted writes or incomplete streams.

## Tool Configuration and Explicit Context Caching

OpenAI function tools produce both camelCase and snake_case configurations. Anthropic mapped tools produce both aliases and retain explicit tool-choice modes. Native Gemini requests containing `tools`, including an empty array, preserve each valid supplied configuration and add its invocation-reporting flag. A missing configuration receives `VALIDATED`; an existing empty object receives only the flag. Without tools, supplied configurations remain unchanged. Malformed configuration aliases or a non-array `tools` value return a client error before account selection; they are not forwarded unchanged to the provider.

Mapped function declarations exclude automatic Google Search injection. Native Gemini declarations are not globally filtered by that mapping rule.

Equivalent, known tool configurations use the existing canonical cachedContents request. Conflicting aliases, snake-only configurations and unrepresented extensions bypass explicit caching. Cache identity covers the represented mode, allowed names, flag values and field presence. A cache-backed generation request omits tools, both configuration aliases and system instructions. Cache creation failure or cache rejection restores the full original generation body.

## Verification

The upgrade fixture in `src/tests/fixtures/responses-format-v1` was written before the format change. The unit suites cover protocol normalization, old-session recovery, controller errors and actual HTTP serialization against a synthetic loopback upstream. These are regression evidence, not live-provider evidence. See [testing.md](testing.md) for validation scope and the [decision record](../.agents/notes/implemented/bug-fix/2026-08-30-responses-history-compatibility.md) for deliberate compatibility boundaries.

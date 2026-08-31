# Proxy Compatibility Reference

## Responses requests and durable history

Role-bearing messages with a missing or non-string `type` use the message path. Explicit empty-string and unknown string types are ignored as whole input items. Non-string roles default to `user`. String roles are retained through input parsing; the shared downstream conversion treats `system` and `developer` as instructions, keeps `assistant` and tool semantics, and degrades every other string role to `user` instead of forwarding an unknown Gemini role. Array content collects every string `text`, including empty strings, joins them with newlines, and then appends validated image blocks. Both `input_image` and `image_url` accept a URL string or a validated URL object. URLs must be non-empty strings, `detail` must be `auto`, `low` or `high`, and other JSON extensions are retained. Supporting the object form for `input_image` is an intentional compatibility extension beyond upstream. Malformed image blocks are ignored rather than forwarded unchecked. Non-array JSON object content contributes no text; the enclosing message remains available to the existing cleanup rules. Top-level input objects, tool outputs and primitive content retain their existing conversion behavior.

Raw history and input parsing share their type resolver. Assistant `phase: commentary`, `msg_thought_` IDs, and the reserved thinking prefix identify transcript-only messages. Filtering precedes compaction, merging, call repair and deduplication. The existing leading-orphan cleanup, terminal assistant-prefill rewrite, and empty-user fallback remain in place.

The ignore rules apply to new input and recovered history during request conversion without rewriting raw stored items or old GET payloads. An empty-type assistant item does not trigger WebSocket transcript replacement. File-reference resolution still precedes input conversion, so unresolved attachment references retain their existing errors even inside an otherwise ignored item or object content.

New non-stream responses emit nonblank reasoning as `reasoning` items with `summary_text`, followed by visible text/refusal and tools. Ordinary message items have no `phase`. The apply_patch diagnostic exception retains commentary. Streaming retains its existing commentary messages and event sequence. Zero cached/reasoning token detail fields are normalized only at the non-stream response boundary.

The production non-stream path selects the first Gemini candidate, concatenates its text blocks without a separator, and constructs one internal Chat Completions choice with string-or-null content and a usage object. Missing upstream usage becomes zero before the final Responses conversion. The non-stream stream-aggregation fallback uses the same normalization. The final Responses mapper is not a general-purpose converter for arbitrary external Chat Completions responses or multiple choices.

When image content is present, the Responses-to-chat conversion omits a text block only when the newline-joined text is exactly empty. It does not trim the joined text: spaces and newlines remain explicit text content. This matches the upstream parser's empty-text boundary without broadening normalization.

Response IDs, function/custom tool IDs, namespaces and call IDs are preserved. Old stored response payloads are replayed unchanged by GET. The durable record format remains version 1 with the existing one-hour TTL, 500-session limit, missing-ID errors, deletion and `store: false` semantics. Recovery requires an entry retained within those limits and a completed disk flush; this is not a guarantee for interrupted writes or incomplete streams.

## Tool configuration and explicit context caching

OpenAI function tools produce both camelCase and snake_case configurations. Anthropic mapped tools produce both aliases and retain explicit tool-choice modes. Native Gemini requests containing `tools`, including an empty array, preserve each valid supplied configuration and add its invocation-reporting flag. A missing configuration receives `VALIDATED`; an existing empty object receives only the flag. Without tools, supplied configurations remain unchanged. Malformed configuration aliases or a non-array `tools` value return a client error before account selection; they are not forwarded unchanged to the provider.

Mapped function declarations exclude automatic Google Search injection. Native Gemini declarations are not globally filtered by that mapping rule.

Equivalent, known tool configurations use the existing canonical cachedContents request. Conflicting aliases, snake-only configurations and unrepresented extensions bypass explicit caching. Cache identity covers the represented mode, allowed names, flag values and field presence. A cache-backed generation request omits tools, both configuration aliases and system instructions. Cache creation failure or cache rejection restores the full original generation body.

## Verification

The upgrade fixture in `src/tests/fixtures/responses-format-v1` was written before the format change. The unit suites cover protocol normalization, old-session recovery, controller errors and actual HTTP serialization against a synthetic loopback upstream. These are regression evidence, not live-provider evidence. See [testing.md](testing.md) for validation scope and the [decision record](../.agents/notes/implemented/bug-fix/2026-08-30-responses-history-compatibility.md) for deliberate compatibility boundaries.

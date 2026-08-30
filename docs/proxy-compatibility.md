# Proxy Compatibility Reference

## Responses requests and durable history

Role-bearing messages without a non-empty string `type` use the message path, including the legacy empty-string form. Explicit unknown string types are ignored. Explicit messages with invalid roles default to `user` at the JSON boundary. Array content collects every string `text`, including empty strings, joins them with newlines, and then appends validated image blocks. Image URL details and JSON extensions are retained. Legacy non-array object content remains serialized as text.

Raw history and input parsing share their type resolver. Assistant `phase: commentary`, `msg_thought_` IDs, and the reserved thinking prefix identify transcript-only messages. Filtering precedes compaction, merging, call repair and deduplication. The existing leading-orphan cleanup, terminal assistant-prefill rewrite, and empty-user fallback remain in place.

New non-stream responses emit nonblank reasoning as `reasoning` items with `summary_text`, followed by visible text/refusal and tools. Ordinary message items have no `phase`. The apply_patch diagnostic exception retains commentary. Streaming retains its existing commentary messages and event sequence. Zero cached/reasoning token detail fields are normalized only at the non-stream response boundary.

Response IDs, function/custom tool IDs, namespaces and call IDs are preserved. Old stored response payloads are replayed unchanged by GET. The durable record format remains version 1 with the existing one-hour TTL, 500-session limit, missing-ID errors, deletion and `store: false` semantics. Recovery requires an entry retained within those limits and a completed disk flush; this is not a guarantee for interrupted writes or incomplete streams.

## Tool configuration and explicit context caching

OpenAI function tools produce both camelCase and snake_case configurations. Anthropic mapped tools produce both aliases and retain explicit tool-choice modes. Native Gemini requests containing `tools`, including an empty array, preserve each supplied configuration and add its invocation-reporting flag. A missing configuration receives `VALIDATED`; an existing empty object receives only the flag. Without tools, supplied configurations remain unchanged. Malformed configuration fields return a client error before account selection.

Mapped function declarations exclude automatic Google Search injection. Native Gemini declarations are not globally filtered by that mapping rule.

Equivalent, known tool configurations use the existing canonical cachedContents request. Conflicting aliases, snake-only configurations and unrepresented extensions bypass explicit caching. Cache identity covers the represented mode, allowed names, flag values and field presence. A cache-backed generation request omits tools, both configuration aliases and system instructions. Cache creation failure or cache rejection restores the full original generation body.

## Verification

The upgrade fixture in `src/tests/fixtures/responses-format-v1` was written before the format change. The unit suites cover protocol normalization, old-session recovery, controller errors and actual HTTP serialization against a synthetic loopback upstream. These are regression evidence, not live-provider evidence. See [testing.md](testing.md) for validation scope and the [decision record](../.agents/notes/implemented/bug-fix/2026-08-30-responses-history-compatibility.md) for deliberate compatibility boundaries.

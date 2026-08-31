# Agent Note: Responses Format Compatibility with Durable History

Status: implemented

## Problem

The target protocol behavior uses a different non-stream reasoning shape and dual Gemini tool configuration aliases. Replacing these fields alone can drop historical commentary filtering, tool-call associations, image metadata, or cache semantics. The chosen defaults must coexist with our existing persistence and cache paths.

## Decision

This decision supersedes the non-stream reasoning and camel-only tool decisions in [the earlier compatibility note](2026-08-30-openai-responses-tool-compatibility.md). Other safeguards in that note remain applicable. Current behavior is documented in [the proxy compatibility reference](../../../../docs/proxy-compatibility.md).


The object-content change is confined to message content; top-level input objects, tool output serialization and other primitive content are not changed. Empty-type assistant items also stop triggering WebSocket transcript replacement through the shared parser. The user explicitly approved retaining the existing file-reference preflight as a replication exception: it can still reject an unresolved attachment inside an otherwise ignored item or object content. Input conversion does not bypass attachment error handling. The user also retained image URL validation as a replication exception: non-empty URLs, supported detail values and JSON extensions pass, while malformed image values are ignored instead of being copied unchecked as upstream does. Unlike upstream, the same validated object form remains accepted for `input_image`; this is a deliberate compatibility extension so existing clients do not silently lose images. Unknown string roles remain another explicit exception: after system, developer, assistant and tool handling, the shared OpenAI conversion maps other roles to `user` rather than forwarding an unsupported role verbatim to Gemini. This shared behavior remains unchanged for Chat Completions.

Emit both tool configuration aliases for mapped function calls, with explicit source profiles at all OpenAI and Anthropic entry points. Keep the existing explicit Anthropic tool-choice semantics. Native Gemini aliases retain independently supplied valid fields and defaults. The user explicitly retained strict request validation as a replication exception: malformed aliases and non-array `tools` return a client error before account selection instead of following upstream's behavior of leaving non-object aliases unchanged for provider handling.

Only cache tool configurations representable by the existing cachedContents API. Equivalent aliases use its canonical camelCase payload; conflicting aliases and unknown extensions bypass explicit caching. Cache-backed generation removes both aliases. Failed cache creation and rejected cache resources use the untouched full generation body.

## Alternatives considered

- Redesign the streaming format: rejected; streaming commentary and event order stay unchanged.
- Rewrite all stored responses to the new reasoning shape: rejected; old GET payloads and tool references are client-visible durable state.
- Retain the legacy empty-type and object-content replay behavior: superseded by the user's explicit decision to ignore those inputs. No migration rewrites historical records.
- Discard snake_case only during caching: rejected; this can silently change the requested function mode or allowed names.
- Replace durable history with an in-memory store: rejected; durable recovery is an explicit user requirement.
- Rewrite credential synchronization: rejected; existing implementation already provides the relevant behavior and stronger atomic-file guarantees.

## Consequences

The remaining output-shape audit distinguishes a narrow internal contract from an external compatibility gap. Upstream's final Responses helper accepts multiple Chat Completions choices, array content, and absent usage. Our production producer selects the first Gemini candidate, joins text blocks, and always constructs one choice and usage before calling the final mapper. Adding branches only to that final mapper would not recover additional candidates discarded earlier. No multiple-candidate feature or broader response type is introduced by this audit.

For empty-text-plus-image input, the intermediate chat conversion now omits a text block only when the newline-joined text is exactly `''`, matching upstream's parser boundary. It intentionally does not trim: spaces remain text, and two empty blocks join to a non-empty newline that remains text. The following chat-to-Claude conversion still produces image-only Gemini content for the strictly empty case.

Non-stream and streaming reasoning intentionally have different representations. New reasoning items are ignored during upstream history replay; old commentary is still removed. Normal assistant text is retained unless an existing transcript-only marker identifies it. Newline joining prevents adjacent text blocks from accidentally forming the reserved thinking prefix.

History that relied on empty-type messages or serialized object content loses that contribution when continued, even though the original stored items and GET response remain unchanged. An object-content message becomes empty at conversion rather than being removed wholesale; normal downstream cleanup still applies. This is an intentional input-compatibility change, not a claim of byte-for-byte equivalence with every upstream parser edge case.

Configuration extensions continue to reach generation, but bypass explicit caching until the cache API can represent them. No durable migration, database change, authentication change, new dependency, or release action is included.

## Verification

The old-session fixture was generated with the pre-change writer, before production edits. It remains unchanged while its assertions verify that recovered raw legacy items are preserved and their unsupported content is ignored during conversion. Regression tests exercise recovery, raw response equality, IDs, function output association, whitespace, usage details, SSE/WebSocket behavior, all three protocol service paths, and credentials. Loopback HTTP tests use the real GeminiClient and Axios Node adapter to observe serialized cache and generation requests, including cache failure and fallback.

The input-rule regressions check full converted message lists, preservation of enclosing messages, empty-user fallback, and WebSocket append history. The Responses real-path harness exercises both streaming and non-streaming operations through the production service and mapper chain and compares complete upstream `contents`; its account lease and upstream client are synthetic, not live Google or HTTP transport evidence. Before the production change, the ignore-rule assertions failed on the legacy conversion and transcript-replacement behavior.

Attachment-preflight regressions place file references inside both ignored input forms with the file service unavailable. They assert the exact 404 `file_not_found` response, no account selection or upstream request, and unchanged input objects.

Additional real-path fixtures return multiple Gemini candidates, interleaved text/thought parts, and no usage metadata. Both direct non-stream generation and stream aggregation produce one Responses answer with concatenated text and zero usage. Only generated response ID and creation time are read from the result when constructing the full expected payload. Paired image fixtures with and without an empty text block produce the same complete upstream `contents`; a focused conversion test additionally distinguishes strictly empty joined text from spaces and newlines. These tests exercise production mapping with a synthetic upstream, not provider acceptance of those inputs.

Live provider, Codex CLI, and desktop UI results are recorded separately in the execution artifacts. A build, mocked provider, local HTTP server, or authenticated provider error must not be reported as successful real model generation.

`npm run start` exposed constructor metadata erased by the Vite main-process build. The batch binder, OpenAI controllers, and Gemini client's 4xx capture dependency now declare explicit Nest injection tokens, with metadata regression coverage. In the live run, `/v1/models` returned 200 and the generation request reached Google, which returned `403 UNSUPPORTED_LOCATION`; the gateway preserved that upstream status instead of replacing it with a local 500. Codex CLI 0.151.0 and the backend binary bundled with Codex App 26.825.6671.0 both created a Responses turn through the gateway, then received 429 after the provider failures exhausted the eligible account pool. Successful live generation and live response-ID continuation therefore remain unverified in this environment.

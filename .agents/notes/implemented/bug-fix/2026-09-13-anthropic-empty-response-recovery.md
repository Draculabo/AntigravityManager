# Agent Note: Anthropic Empty Response Recovery

Status: implemented

## Problem

Gemini can terminate a minimal probe request without emitting text, thinking or a tool call. The non-stream Anthropic adapter then returned an empty `content` array, while the streaming adapter either rejected a zero-byte stream or emitted termination events without a content block. Anthropic clients that require a non-empty response could wait indefinitely or reject the response.

## Decision

The Anthropic response mapper appends one text block containing `.` only when normal mapping produced no content. The streaming state tracks meaningful thinking and content. At normal termination with neither, it emits a minimal sequence: a reused or synthetic `message_start`, a `content_block_start` whose text is `.`, `content_block_stop`, an `end_turn` `message_delta` with one input and one output token, and `message_stop`. The recovery block intentionally has no `text_delta`.

The fallback is Anthropic-specific. A native Gemini zero-byte stream keeps its existing error, and upstream stream errors are not converted into successful responses. Empty thought parts without a signature remain non-content and therefore receive the fallback; real text, tools, images, grounding and signature-bearing thinking do not.

## Alternatives considered

- Retaining the empty-stream error leaves health probes and strict Anthropic clients incompatible.
- Adding the fallback to the shared Gemini stream collector would change OpenAI and native Gemini behavior outside the affected protocol.
- Sending `.` as a `text_delta` adds an unnecessary event to the validated protocol sequence.

## Consequences

Normal empty completions become small successful Anthropic responses. The synthetic streaming usage is exactly one input and one output token; non-stream responses preserve upstream usage. Transport errors and idle timeouts keep their existing failure semantics.

## Verification

`claude-response-usage.test.ts`, `streaming-state.test.ts`, `internal-sse.test.ts`, `proxy-real-path-anthropic.test.ts` and the focused empty-stream cases in `proxy-retry-mock.test.ts` cover unary content, exact streaming event order, zero-byte termination, metadata-only termination, non-empty exclusions and unchanged Gemini passthrough behavior.

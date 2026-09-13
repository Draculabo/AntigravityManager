# Agent Note: Anthropic Tool-Call Leakage Recovery

Status: implemented

## Problem

Gemini can occasionally serialize an intended tool call as assistant text using the internal `call:default_api:<tool>{...}` form. Anthropic clients then display the protocol text instead of receiving `tool_use`. Converting arbitrary matching-looking text would be unsafe because documentation, quoted examples or hallucinated tool names could become executable client actions.

## Decision

The Anthropic response mappers recover only a complete text value that begins with the exact internal prefix and names a tool registered on the current request. Matching is case-insensitive, but output preserves the registered spelling. Missing arguments become an empty object. Unary recovery accepts only strict JSON objects; streaming additionally quotes bare object keys before one retry, following the protocol-specific parser contract.

Streaming recovery is allowed only before any ordinary text delta or structured function call in the turn. Successful recovery uses the existing function-call emitter. Every failed guard preserves the original text. The whitelist is supplied only by the Anthropic service and is not enabled for shared OpenAI mapper callers.

The Anthropic streaming start event also always carries usage. Upstream usage wins, then an explicit fallback, then exactly `{ input_tokens: 0, output_tokens: 0 }`.

## Alternatives considered

- Unconditionally recognizing the prefix could execute examples or hallucinated tools that the client never exposed.
- Dropping malformed candidates would hide provider output and make failures difficult to diagnose.
- Sharing the recovery default with OpenAI would broaden behavior beyond the affected protocol.
- Applying the loose parser to unary responses would violate the intentional unary/streaming parser split.

## Consequences

Known leaked Anthropic tool calls become ordinary `tool_use` responses while ambiguous input remains visible text. Recovery cannot occur after partial prose or a native tool call, so it cannot silently reorder a mixed streamed response. Tool availability is bound to the request that reached the selected account and model-variant path.

## Verification

`claude-tool-call-leakage-recovery.test.ts` covers positive, negative, native-call and stream-order guards. `streaming-state.test.ts` covers start-event usage precedence and zero fallback. `proxy-real-path-anthropic.test.ts` verifies unary and streaming whitelist wiring through the controller, service, request mapper and response mappers.

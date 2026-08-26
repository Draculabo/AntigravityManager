# Agent Note: proxy session and model-routing hardening

Status: proposed

## Problem

Process-wide proxy state must keep conversations isolated and retain active entries under bounded storage. Tool-call signatures can collide across sessions, active signature entries can be evicted, numeric tool enums can be discarded during Gemini conversion, and Anthropic family mappings are not reached by the current routing layer.

## Proposal

Tool-call signatures will keep the current session-scoped composite key and refresh their LRU position on reads and updates. The Responses store will continue to rely on `DurableRecordStore`, whose reads already refresh TTL and LRU order. Gemini-compatible integer and number enums will retain string-backed enum values, and model routing will resolve configured Anthropic family mappings after exact mappings but before built-in mappings.

## Alternatives considered

- Restore a process-global tool-call ID index and mark collisions ambiguous: rejected because the current composite key preserves both sessions without a cross-session lookup path.
- Reintroduce a separate Responses LRU store: rejected because `DurableRecordStore` already owns persistence, TTL, and recency semantics.
- Convert unsupported numeric enums to description hints only: rejected because it removes a usable parameter constraint.
- Apply family mapping before exact mapping: rejected because an explicit user model route must take precedence.

## Acceptance criteria

- A tool-call ID reused across sessions cannot return another session's signature.
- Reading or updating a tool-call signature refreshes its LRU position.
- Responses-session reads retain active entries through `DurableRecordStore` recency semantics.
- Anthropic family mappings route supported Claude family IDs while exact mappings still win.
- Focused SignatureStore, durable Responses, JSON schema, and model-routing tests pass.

## Risks

Gemini enum compatibility is validated only with local schema conversion tests, not a live provider request. Family matching relies on current Claude naming conventions and may need extension for future model identifiers. Durable store behavior is shared across proxy features, so its existing semantics must remain stable.

# Agent Note: OpenAI Codex Identity Normalization

Status: implemented

## Problem

OpenAI Codex clients can include the stale system identity `You are Codex, an agent based on GPT-5.` in top-level Responses instructions or ordinary system/developer messages. Forwarding that provider-specific identity to the Gemini upstream leaves an obsolete model claim in the stable prompt prefix that can conflict with the selected model.

## Decision

The OpenAI-to-Claude conversion normalizes every occurrence of that stale identity to `You are Codex, an agent.` while collecting OpenAI system prompts. This occurs before trimming and cache-key deduplication. The path covers Chat Completions system/developer messages and Responses `instructions`, because Responses instructions first become an OpenAI system message.

The normalization is intentionally local to the OpenAI conversion surface. User messages, tool content, direct Anthropic requests, and native Gemini requests are not rewritten.

## Alternatives considered

**Add the replacement to the shared stable-prefix sanitizer.** Rejected because the sanitizer also serves direct Anthropic request mapping, which would broaden an OpenAI compatibility fix into another protocol without a demonstrated need.

**Normalize all message content.** Rejected because callers may intentionally quote the legacy identity in a user message; changing it would alter user-visible semantics.

**Keep the stale identity and rely on later Gemini mapping.** Rejected because the relevant text is part of the system prompt, not the model-routing field, and reaches the upstream stable prefix before later request processing.

## Consequences

OpenAI system instructions retain their wording except for the obsolete model claim. Duplicate detection runs over the normalized text, so semantically identical current and stale identities no longer produce separate system-prefix entries. Model routing, user content, and non-OpenAI protocol behavior are unchanged.

## Verification

The focused OpenAI conversation-order test covers top-level Responses instructions, system and developer messages, and verifies that a user echo remains unchanged through the Gemini request mapping. ESLint and Prettier pass on both touched files. A real streamed `/v1/responses` request containing the stale identity in `instructions` completed successfully through the running application gateway.

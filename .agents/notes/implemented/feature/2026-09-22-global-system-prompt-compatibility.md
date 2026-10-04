# Agent Note: Global system prompt compatibility

Status: implemented

## Problem

A gateway-wide system prompt needs a separate configuration field and a predictable position relative to identity and caller instructions. Native Gemini requests must avoid duplicate injection, and saved changes must reach subsequent requests even when the gateway is stopped.

## Decision

Add a backward-compatible, default-disabled `proxy.global_system_prompt` configuration with `enabled` and `content` fields. Resolve it per request from the already-hot `server-config` snapshot. For OpenAI and Anthropic mappings, render it as a dedicated system-instruction section after identity and before caller customizations. For native Gemini requests, prepend one trimmed text part followed by two newlines, unless an existing text part already contains the configured prompt.

The existing config save handler already synchronizes `server-config` without requiring a running gateway, so the new field uses that established hot-update boundary rather than creating a second in-memory store.

## Alternatives considered

- Omitting the configuration field would leave users unable to apply a gateway-wide instruction consistently across protocols.
- Appending raw text to an already rendered instruction would make an identity-like custom prompt bypass the structured instruction layout. A dedicated section preserves identity, spacing, and ordering.
- Applying the prompt to user messages or tool payloads would alter client data rather than system policy. Injection is limited to system-instruction surfaces.

## Consequences

The feature is off by default, so existing requests and persisted configurations retain their behavior. Enabling it intentionally adds user-authored text to every OpenAI, Anthropic, and native Gemini generation request. The prompt is not logged, returned by diagnostics, or used for token-count requests. Native duplicate detection checks whether an existing text part contains the configured prompt; near-duplicate wording is intentionally not normalized.

## Verification

Focused tests cover backward-compatible defaults, save-time synchronization before gateway startup, OpenAI/Anthropic placement and duplicate prevention, and native Gemini spacing and duplicate prevention. The final implementation report records type, formatting, contract, and live-provider checks separately.

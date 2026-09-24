# Agent Note: Proxy Account Scheduling and Stream Completion

Status: implemented

## Problem

Equal round robin ignores useful model-specific quota information, while a stalled or truncated OpenAI-compatible upstream stream can appear to clients as a successful completion. The non-stream fallback used after stream establishment failure can also omit reasoning from its synthetic stream.

## Decision

Keep the existing account eligibility, cooldown, session affinity, and bounded retry rules. After those rules, use the selected model's quota percentage as a bounded round-robin weight of 1, 2, or 3. Unknown quota retains weight 1. The application config switch `proxy.quota_aware_scheduling_enabled` defaults to true and can restore equal weights without changing the account database.

Preserve reasoning when synthesizing an OpenAI Chat or Responses stream from a complete response. Treat upstream transport errors, idle timeouts, and empty streams as failures. A clean EOF after meaningful output is a valid termination because a live Gemini stream can omit both `finishReason` and usage metadata. Chat infers a `stop` finish, Responses completes, and native Gemini passes through the clean EOF. Anthropic retains its clean-EOF compatibility behavior. No account replay occurs after output has begun.

## Alternatives considered

- Strict quota ordering was rejected because quota snapshots can be stale or absent and would starve healthy accounts.
- A fixed account reuse interval was rejected because it would override model capability, cooldown, and session-specific routing signals.
- Sending `[DONE]` on timeout was rejected because it makes an incomplete answer indistinguishable from a successful one.
- Requiring `finishReason` on every clean EOF was rejected after a live `gemini-3-flash` request returned one content frame and a normal transport end without a terminal metadata frame.
- Replaying after partial output was rejected because clients may already have observed text or tool calls.

## Consequences

Quota-aware selection adds a small preference but remains fair to accounts with unknown or low reported quota. Existing configuration files acquire the new default through config parsing. Clients must handle stream error events and `response.failed`; they no longer receive a false success marker for an interrupted stream.

## Verification

Focused policy and stream tests cover weighting, the feature switch, synthetic reasoning, clean EOF without a finish reason, empty streams, transport errors, and mapper failure events. A live account-service probe covered three distinct accounts over eight selections and preserved one account for a repeated session key. Through the live HTTP gateway, five successive requests returned 200 and selected two different accounts; two further requests with the same session key stayed on one account. Live Chat, Responses, native Gemini, and Anthropic requests completed, and a Claude thinking request emitted `reasoning_content`. Controlled disconnection after a real upstream frame produced a Chat stream error without `[DONE]`, `response.failed` for Responses, and a native Gemini error event. Idle timeout remains covered by regression tests rather than a live wait.

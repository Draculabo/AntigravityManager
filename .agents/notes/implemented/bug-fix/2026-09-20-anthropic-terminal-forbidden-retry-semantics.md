# Agent Note: Anthropic Terminal Forbidden Retry Semantics

Status: implemented

## Problem

The shared retry service now preserves the last non-rate-limit provider error after account rotation, which is correct for OpenAI and Gemini. Anthropic therefore receives a terminal 403 at its controller boundary. Claude clients interpret a public 403 as an invalid local login and can leave the normal retry path even though the failure is caused by the gateway's exhausted account pool.

The Anthropic response boundary maps a terminal 403 to 503 because this preserves the client's normal retry behavior for a temporary local account-pool failure. The shared [tool-quota routing and account-pool policy](2026-09-15-tool-quota-routing-and-account-pool-errors.md) remains authoritative for request classification and retry timing; this note records the provider-specific response-boundary rule.

## Decision

`BaseProxyController.sendAnthropicErrorResponse()` maps a terminal provider error whose resolved status is 403 to HTTP 503. The Anthropic error body remains in its existing dialect and the original sanitized message remains unchanged. `Retry-After` handling remains unchanged and still runs before the response is sent.

The mapping is provider-specific and stays at the Anthropic controller boundary. `ProxyRetryService` remains provider-neutral: it preserves the last non-429 provider error after real provider attempts, returns 429 only when every recorded failure was 429, and reserves `ProxyAccountUnavailableError(503)` for pool acquisition failure before a provider request. OpenAI and Gemini continue to expose terminal provider 403 as 403.

## Alternatives considered

- Reintroduce a global 403-to-503 conversion in shared retry logic. Rejected because it changes OpenAI and Gemini's external status contract and again hides actionable provider permission failures.
- Replace the terminal upstream error with a shared pool-unavailable error. Rejected because doing so destroys provider-neutral error meaning before the protocol adapter can apply its client-specific policy.
- Preserve Anthropic terminal 403 verbatim. Rejected because Claude clients can treat it as a local authentication failure even when account rotation, rather than the client's credentials, is exhausted.

## Consequences

Both `/v1/messages` and `/v1/messages/count_tokens` use the same Anthropic error response boundary and now return 503 for terminal provider 403 responses. The account penalty and retry behavior remain unchanged. OpenAI and Gemini controller paths remain unaffected, as does all-429 handling and its `Retry-After` value.

The mapping deliberately applies only to structured provider failures, so local `HttpException` validation and authentication errors keep their own statuses.

## Verification

- `npm test -- --run src/tests/unit/anthropic-count-tokens.test.ts src/tests/unit/proxy-controller.integration.test.ts src/tests/unit/proxy-real-path-parity.test.ts src/tests/unit/gemini-count-tokens.test.ts src/tests/unit/proxy-retry-policy.test.ts`
- `npm run type-check`
- `npm run check:agent-contracts`

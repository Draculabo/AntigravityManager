# Agent Note: Tool-Quota Routing and Account-Pool Failure Handling

Status: implemented

## Problem

The proxy gateway needs one routing rule for v1internal requests. Without it, plain-text, tool-oriented, and image traffic can expose inconsistent request metadata across protocol adapters and select an unintended resource or credit policy.

Account-pool handling must distinguish three outcomes: no local account before a provider request, a completed all-rate-limited rotation, and a completed rotation with a non-rate-limit provider failure. Collapsing those outcomes loses actionable status information and can produce incorrect retry behavior.

Finally, an unstructured bare `quota_exhausted` marker was treated as durable quota exhaustion even without a reset delay. This produced long backoff behavior from an ambiguous short-limit signal.

## Decision

`ToolQuotaRoute.requiresToolQuotaRoute()` is the shared rule for tool-enabled routing. A request uses that route only when it contains at least one tool declaration or a content part containing `functionCall`, `functionResponse`, `tool_use` or `tool_result`. Image generation remains explicitly classified as `image_gen`.

The OpenAI and Anthropic adapters omit `requestType` for plain text, send `requestType: "agent"` for tool-enabled requests and send `requestType: "image_gen"` for images. They do not send `enabledCreditTypes`. The Gemini adapter uses the same rule and adds `enabledCreditTypes: ["GOOGLE_ONE_AI"]` only for tool-enabled requests. Plain Gemini requests omit both fields.

`ProxyAccountUnavailableError` represents deliberate account-pool availability outcomes and an optional numeric retry delay. Initial account-pool acquisition failure remains HTTP 503. After actual provider attempts, the retry service returns HTTP 429 only when every recorded failure is a structured 429; otherwise it preserves the last non-429 provider error. The Anthropic response boundary maps a terminal provider-side 403 to HTTP 503 to preserve client retry behavior, while OpenAI and Gemini retain the provider status. The account-lease module reports the shortest active model-scoped wait across eligible accounts, and protocol controllers emit its rounded value as `Retry-After` before writing the response.

Structured Google `details[].reason = QUOTA_EXHAUSTED` remains authoritative without a delay. Daily, per-day and quota-reset signals also remain durable quota exhaustion. A bare unstructured `quota_exhausted` marker requires a parseable header, structured-body or text delay; without one it is a short rate limit.

## Alternatives considered

- Change `AccountLeaseService.getNextToken()` to return a discriminated result. Rejected because the method has many non-proxy consumers and would expand a transport-specific error change into a broad lease contract migration.
- Parse the final `No available accounts` string in each controller. Rejected because strings lose both failure composition and retry timing, and protocol controllers would drift again.
- Convert every post-provider non-429 failure into a generic pool error. Rejected because it hides actionable provider status from OpenAI and Gemini clients.
- Use an application branch label as the plain-text `requestType`. Rejected because the field expresses request semantics, not local control flow.
- Treat every textual `quota` occurrence as durable exhaustion. Rejected because generic resource exhaustion and ambiguous quota text are also used for short rate limits.

## Consequences

Plain text traffic no longer opts into tool-enabled or Google One credit handling. Requests with tools or historical tool interaction retain their tool-aware route, and image behavior is unchanged. The shared route utility is used by both mapper families, so future protocol adapters must not recreate keyword logic independently.

Clients can distinguish temporary account-pool unavailability, a completed all-429 rotation, and a non-rate-limit provider failure. Anthropic treats its terminal permission failure as temporary service unavailability without changing the shared retry policy. The error body remains in each protocol dialect, and no account identity or credential detail is added.

The account-lease return type remains unchanged. Retry timing is exposed through a narrow read-only pool method used by the retry service.

## Verification

- `npm test -- src/tests/unit/tool-quota-route.test.ts src/tests/unit/claude-request-mapper-cache-compatibility.test.ts src/tests/unit/proxy-internal-request-mapping.test.ts src/tests/unit/gemini-tool-config-wire.test.ts src/tests/unit/weekly-warmup-wire.test.ts src/tests/unit/proxy-real-path-gemini.test.ts src/tests/unit/rate-limit-tracker.test.ts src/tests/unit/rate-limit-tracker-model-scope.test.ts src/tests/unit/account-lease-pool-retry-after.test.ts src/tests/unit/account-lease-selection-policy.test.ts src/tests/unit/proxy-retry-policy.test.ts src/tests/unit/proxy-controller.integration.test.ts src/tests/unit/gemini-controller.integration.test.ts src/tests/unit/image-rate-limit-lifecycle.test.ts`
- `npm test -- src/tests/unit/anthropic-count-tokens.test.ts src/tests/unit/gemini-count-tokens.test.ts`
- `npm test -- src/tests/unit/proxy-retry-mock.test.ts -t "omits requestType and credits for a plain Gemini stream"`
- `npm run type-check`
- `npm run check:agent-contracts`

# Agent Note: Daily Endpoint Priority

Status: implemented

Partially superseded by: [Bounded internal endpoints](2026-11-05-internal-endpoint-configuration.md)
for current candidates and regional fallback policy. The observed October runs below remain
historical evidence.

## Problem

Real Windows and Linux coding-tool acceptance repeatedly records production Cloud Code 429
followed immediately by Daily 200 on the same account. Responses identify RESOURCE_EXHAUSTED
without a reset delay. This demonstrates an endpoint-dependent failure in the observed runs;
it does not establish Google's internal capacity or quota cause.

## Decision

The confirmed D10 policy uses Daily, Sandbox, then production in the default GeminiClient
endpoint list. Explicit environment overrides retain validated, deduplicated preference.
Regional HTTP fallback permits 408/404/5xx; 429 and 499 remain with account/request failure
ownership. The replacement decision defines candidate bounds and configuration failure.
The earlier Daily-before-Prod decision followed local observations and did not prove that
regional failover eliminates quota rejection.

## Alternatives considered

- Increasing retries preserves an unnecessary failed first request and adds latency.
- Treating every RESOURCE_EXHAUSTED as exhausted account quota misclassifies these same-account
  successes at another endpoint.
- Persisting a preferred endpoint per account adds state without demonstrated need.

## Consequences

The first default generation attempt reaches Daily. Sandbox and production remain bounded
fallbacks for the current retryable statuses; quota rejection does not initiate regional retry.

## Verification

Current tests exercise actual request ordering, identical credentials and body across allowed
failover, explicit overrides and stopping after success. The October acceptance observed 429
failover under the earlier policy. Live evidence remains
separate from complete task success: a client can receive successful responses and still fail
its local tools or exceed the task timeout.

See the [architecture reference](../../../../docs/architecture.md) and
the local live acceptance report (`artifacts/coding-tool-configuration-acceptance-2026-10-04.md`).

# Agent Note: Daily Endpoint Priority

Status: implemented

## Problem

Real Windows and Linux coding-tool acceptance repeatedly records production Cloud Code 429
followed immediately by Daily 200 on the same account. Responses identify RESOURCE_EXHAUSTED
without a reset delay. This demonstrates an endpoint-dependent failure in the observed runs;
it does not establish Google's internal capacity or quota cause.

## Decision

Prefer the already supported Daily endpoint before production in the default GeminiClient
endpoint list. Keep both endpoints, explicit environment ordering, failure classification,
account selection and retry bounds unchanged. A third endpoint is unnecessary for the observed
failover behavior. This ordering follows the local acceptance evidence and does not assume that
it eliminates all 429 responses.

## Alternatives considered

- Increasing retries preserves an unnecessary failed first request and adds latency.
- Treating every RESOURCE_EXHAUSTED as exhausted account quota misclassifies these same-account
  successes at another endpoint.
- Persisting a preferred endpoint per account adds state without demonstrated need.

## Consequences

The first default generation attempt now reaches Daily. Production remains a fallback for the
existing retryable statuses.

## Verification

Tests exercise actual request ordering, identical credentials and
body across 429 failover, explicit overrides, and stopping after success. Live evidence remains
separate from complete task success: a client can receive successful responses and still fail
its local tools or exceed the task timeout.

See the [architecture reference](../../../../docs/architecture.md) and
[live acceptance report](../../../../artifacts/coding-tool-configuration-acceptance-2026-10-04.md).

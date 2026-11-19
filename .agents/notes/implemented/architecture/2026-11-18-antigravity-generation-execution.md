# Agent Note: Antigravity generation execution

Status: implemented
Date: 2026-11-18

## Problem

The three protocol services inherited Antigravity send, replay, and aggregation behavior
from a base class that also managed account and protocol concerns. The unary and streaming
paths constructed the same streaming attempt independently.

## Decision

Compose a shared Antigravity generation executor with the existing upstream transport.
Each call receives one routed body, the selected account's transport inputs, and the
request's existing cancellation signal and recovery options. The executor owns thinking
recovery and stream aggregation for that account. The transport owns physical sends and
endpoint selection.

Each logical request constructs one account execution. Its account iterator owns pool
selection, backoff, grace retries, and failure settlement. The account execution also owns
the request's project, thinking-only, and overload recovery admission. A protocol can
perform its existing same-account fallbacks before reporting a failure to the iterator.

## Alternatives considered

A callback that also handled protocol fallback, preflight, and commit would either duplicate
protocol rules or need to expose those rules as many hooks. The iterator retains account
policy while the protocol services control those operations.

## Consequences

The executor has no mutable request state of its own. Concurrent calls retain the shared
aggregation admission policy and use their caller's request budget. A stream can take
ownership of the image permit. Iteration exit releases a permit still held by the account
execution even if model resolution fails before sending. Protocol adapters decide when to
publish their response events and commit a successful account outcome.

## Verification

The [thinking recovery tests](../../../../src/tests/unit/thinking-only-recovery-path.test.ts),
[aggregation admission tests](../../../../src/tests/unit/aggregation-admission.test.ts), and
[replay budget HTTP tests](../../../../src/tests/unit/d10-upstream-generation-http.test.ts)
cover provider recovery, cancellation, and physical send budgets.

The [ordinary retry fixtures](../../../../src/tests/unit/proxy-ordinary-retry-rounds.test.ts)
check account order and the [image lifecycle fixtures](../../../../src/tests/unit/image-rate-limit-lifecycle.test.ts)
check release and stream ownership transfer.

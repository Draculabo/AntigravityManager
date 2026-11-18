# Agent Note: Same-account generation overload recovery

Status: implemented

## Problem

An upstream model-overload response previously entered account or protocol
fallback without an opportunity to reduce automatically selected thinking work
on the same account.
The 2026-11-08 implementation preserved explicit choices. A subsequent live
probe showed a bare Gemini family produced a final `HIGH` wire level, so that
path could not use adaptive-budget recovery. The user approved extending recovery to these requests.

## Decision

Keep the existing request-local recovery owner and evaluate the final failed wire
body before regional failover, where a later 429 could otherwise hide a prior
503. Recognize plain 503 and 529 for thinking reduction and marked 503/504
capacity failures for promotion. Each transformation gets one allowance across
ordinary fallbacks, and the retry reuses the failed transport and live account
lease. Tier selection applies to explicit as well as automatic requests. The
physical sibling must be eligible on the account, and model-bound cached content
prevents a model change.

Keep the original output allowance, stream replay boundary, cancellation and
deadline. Preserve audit attribution for the actual retried model and leave
ordinary quota handling in place. See the [current compatibility
contract](../../../../docs/modules/proxy-gateway/compatibility.md#account-scheduling-and-stream-completion).

## Alternatives considered

- Retaining only the original adaptive-budget rule leaves tiered Gemini requests
  in the general regional failover path even when lowering work could recover them.
- Wrapping each protocol's account loop would repeat preparation and risk divergent
  replay rules. The common client owns the final wire representation and transport.
- A global allowance would couple unrelated requests; a per-account allowance
  could degrade multiple times as one request rotates through the pool.

## Consequences

Explicit and automatic requests may recover at a different physical tier or with
less thinking work. Recovery probability and provider prefix-cache benefits
depend on the live service. Additional sends consume request time and possible provider quota. The
original deadline and cancellation still own the complete request lifecycle.
The structured decision log excludes payloads and credentials. Removing the
task-owned source changes restores the earlier policy without a data migration.

## Verification

See the implementation and evidence (local artifact `d06-overload-status.md` in the 2026-11-07 review collection)
for negative controls, focused checks, runtime boundaries and environment limits.
Controlled HTTP fixtures use production ingress, protocol services and upstream
HTTP transport with synthetic account leases and a disposable local upstream.
Installed-client and real-provider overload acceptance remain pending.

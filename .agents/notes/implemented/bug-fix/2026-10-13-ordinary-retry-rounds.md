# Agent Note: Ordinary request rounds and bounded grace

Status: implemented

## Problem

The expanded ordinary attempt ceiling did not permit a second round because every
previously selected account remained excluded. Anthropic generation and token
counting spent normal slots on same-account grace. The old protocol-dependent
grace windows could not express a single-account 30-second window or a later-round
five-second window. Selector waits could stack on top of capped retry waits.

## Decision

`OrdinaryRetryRounds` owns normal selections, round exclusions, pool-derived
ceilings, buffered grace eligibility and one non-renewing retry-wait deadline.
Protocol loops keep their existing internal recovery semantics. Grace is limited
to one allowance per account and does not advance the normal counter.

The account lease exposes a read-only current wait query which excludes forbidden,
validation-blocked, OAuth-disabled and hard-quota accounts. It resolves physical
model routes and preserves account-first quota eligibility. Later rounds wait for
current transient locks within a per-wait cap, then use normal selection. They
never clear locks. Cached grace tokens must remain eligible before reuse.

Retry selections disable selector waits. Initial selection shares one wait deadline
across refresh failover and also observes the ordinary request's existing deadline
and abort signal. It can wait once per selection for a short pool lock/cooldown or
the parity cache-first session account, then rechecks current account identity,
health, model capability and locks. It never returns a pre-wait eligible snapshot
after all candidates become unavailable. Hydration and image scheduling retain
their own lifecycle. Current retry behavior belongs in
[proxy compatibility](../../../../docs/modules/proxy-gateway/compatibility.md).

Candidate IDs use deterministic binary order before existing weighted rotation or
account-first choice. Storage reload order is not scheduling evidence. Priority
fields remain D18 work; subscription/health ranking is not added speculatively.

## Alternatives considered

- Clearing all locks to force the expanded send count would bypass durable quota
  evidence and interfere with other requests.
- Permanently excluding every selected account would leave the new ceiling
  ineffective in smaller pools.
- Keeping separate protocol grace windows would leave Anthropic and token-count
  behavior inconsistent with ordinary generation.
- Adding a second transport timeout would change an unrelated lifecycle contract;
  this change bounds retry waiting and checks time before further sends instead.

## Consequences

Potential pool size determines the ceiling once; actual send count depends on
current health and locks. Computed backoff is a lower bound when a shared transient
lock remains longer. After a capped wait, still-locked accounts remain unavailable.
Classify hard-quota failures before applying single-account retry behavior.

The request deadline bounds retry waits and subsequent eligibility for sending;
it also bounds initial selection waits but does not cancel account hydration or
replace transport timeouts. Successful affinity has its
[separate owner](2026-10-15-success-only-account-affinity.md). Account removal during
selection waiting is observed through cache-entry identity; complete deletion and
in-flight token/project work remain separate D01-R12 obligations.

## Verification

Controlled regression evidence is recorded in
the D01 rounds report (local artifact `D01-ordinary-rounds-implementation.md` in the 2026-10-11 review collection).
Coverage includes generation and stream establishment across four protocol
surfaces, both token-count surfaces, normal/grace budgets, buffered window edges,
deadline and cancellation, real account-lease cooldowns, physical model quota,
account deletion/disable during grace, and suppression of stacked selector waits.
Live-provider acceptance remains deferred by the user's rollout contract.

Initial-selection evidence additionally covers storage permutations, weighted and
account-first behavior, insufficient budgets, cancellation cleanup, cooldown-only
pool recovery, extended locks and stale candidates after a cache-first wait.
Production lease/retry fixtures cover request deadlines, cancellation, model
capability denial, account replacement and hard-quota changes while waiting. The
original seven ordering/recovery negative controls all failed before the fix.

# Agent Note: Ordinary account rotation budget and delay

Status: implemented

## Problem

A zero-based attempt loop can contact a third account after two transient 429
failures. Waiting before knowing whether another account exists adds latency to
terminal failures. OpenAI stream establishment also retried the same account in
non-stream mode after 429, bypassing the intended account rotation.

## Decision

The shared retry state owns an OrdinaryAccountRotation instance per operation.
It counts distinct selected accounts that actually returned an unhinted HTTP 429
without explicit durable quota evidence. After two such accounts it stops before
another lease selection. Image requests retain their separate scheduler rules.

Ordinary rotation waits after selection: 50 ms after HTTP 429 and the existing
jittered delay otherwise. Cancellation clears the timer and prevents the next
upstream call. No candidate means no additional rotation wait. The lease exposes
a read-only current candidate count using capability, exclusion, validation,
cooldown and existing account-first quota eligibility. The snapshot neither
hydrates accounts nor binds sessions; it is not a capacity reservation.

An eligible alternative prevents same-account grace. Cache-first selection only
waits for its sticky account when that account remains in the request pool.
OpenAI ordinary stream-establishment 429 failures go directly to shared retry;
other existing fallback behavior is retained.

## Alternatives considered

- Counting loop indices leaves protocol-specific grace and fallback behavior
  coupled to the account budget; account identities provide the required bound.
- A third-account probe could succeed, but the confirmed policy deliberately
  reserves that account for other requests.
- Waiting for an excluded sticky account cannot recover that candidate in this
  operation and delays a valid alternative.

## Consequences

- Selection and hydration may still add latency; 50 ms describes the rotation
  timer, not an end-to-end response guarantee. Selection-time session binding
  remains until the separate success-time binding slice is implemented.
- Single-account attempt/grace expansion and multi-account later-round grace
  remain pending. No quota locks or durable formats are changed by this slice.

## Verification

Controlled protocol-service tests cover Chat, Responses, Anthropic and Gemini,
including stream establishment failure and successful streams, token counting,
hint-bearing and hard-quota separation, cancellation, mixed failure diagnostics
and independent operation budgets. Account-lease tests cover candidate snapshots
and retain cache-first waits for non-excluded accounts. The excluded-affinity
regression failed before its guard was applied.

Checks use synthetic accounts and local upstream fixtures. The replication
artifacts record results separately from deferred live-provider acceptance.
See [current compatibility behavior](../../../../docs/modules/proxy-gateway/compatibility.md).

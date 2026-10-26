# Agent Note: Account-wide resource cooldown escalation

Status: implemented

The shared rate-limit tracker uses the confirmed D01 transient cooldown rule;
the rest of D01 remains in progress.

## Problem

Unhinted generic RESOURCE_EXHAUSTED HTTP 429 responses imposed a fixed 30-second
model lock. The confirmed replication contract requires 5/15/30-second account-wide
escalation, while retaining model-scoped eligibility and independent quota/capacity
histories. Reusing the existing model failure count would keep independent steps
per model or accidentally couple generic limits to quota backoff.

## Decision

The tracker owns an AccountResourceBackoff object with an account-keyed, capped
step and last-failure timestamp. Only HTTP 429 responses classified as transient
rate limits, containing the generic resource signal and lacking a parsed hint,
advance this history. Other classifications keep the existing tracker paths.

The history expires at one hour after its last qualifying failure. Account and
model success clear the account's resource history; ordinary expired-lock cleanup
keeps unexpired history. Explicit tracker reset clears this history. Lock cleanup's
return count continues to count removed locks, rather than history entries.

The tracker still applies the chosen delay to the affected model. Existing explicit
long quota deadlines retain precedence over later transient errors, and model
success does not clear another model's quota lock. No credentials, persistence
formats, protocol envelopes, request budgets or image permits change.

## Alternatives considered

- Keep a fixed 30-second cooldown: rejected because it delays first recovery and
  contradicts the confirmed rule.
- Reuse the model-keyed failure counter: rejected because models would not share
  the generic step, or quota/capacity histories would become coupled.
- Apply an account-wide lock: rejected because model X being busy does not prove
  model Y is unavailable.
- Add another account-selection or retry loop: rejected because the existing
  tracker and lease penalty owner already consume this policy.

## Consequences

The first generic failure recovers sooner. Repeated generic failures across models
can increase the next model's delay without locking unrelated models. Request
budgets, short waits and success-time binding are separate remaining D01 slices;
this change does not claim the whole domain is implemented.

## Verification

The new virtual-clock tracker tests observed the pre-change fixed delay and failed
before implementation. They check complete lock objects, cross-model/account
isolation, success and one-hour reset, hint/category separation, explicit quota
precedence and lock cleanup/reset. The lease policy test additionally checks email
to account-ID normalization through the production penalty and success owners.

Focused tracker, model-scope, lease-limit and retry-policy suites, TypeScript and
governance checks are recorded in the D01 slice report under the replication
artifacts. They use synthetic tokens/errors and no external accounts, models or
client tools. The initial test launch hit a sandbox temporary-cache rename error;
the successful runner uses a workspace-local child-process TEMP/TMP directory.
Live-provider acceptance remains deferred until all 28 in-scope domains have
stage conclusions. See [current compatibility behavior](../../../../docs/modules/proxy-gateway/compatibility.md)
and the replication scope (local artifact `replication-scope.zh-CN.md` in the 2026-10-11 review collection).

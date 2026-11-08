# Agent Note: Independent API account continuity

Status: implemented

API account strategy is distinct from official client account switching.

## Problem

The account-page auto-switch toggle controls official client credentials, while API requests use gateway leases. Users could reasonably expect that disabling the toggle also stopped API rotation, particularly for unrelated agent requests without stable conversation identifiers.

## Decision

Keep the existing balanced strategy as the default and add proxy.account_selection_strategy with balanced and account-first variants. Expose the choice on the API Proxy page and explain the client switch separately on the Accounts page. The existing service configuration and typed update path own persistence and runtime application; no account database schema changes.

Account-first keeps an eligible account per model across requests. Explicit preferred accounts and available conversation bindings take precedence. The policy respects model capabilities, exclusions, cooldowns, rate limits, and exhausted cached quota; a replacement remains preferred when the original account becomes available again. Typed refresh rejection uses the existing bounded fallback loop. At most 256 temporary model bindings are retained; strategy changes and service restarts discard them. The experimental parity scheduler cannot silently disable this user-selected strategy.

The optional weekly_quota_priority_enabled setting defaults to false. When enabled,
new unbound requests can prefer an eligible physical-model weekly quota resetting
within 24 hours before model-level retained affinity and manual priority. Existing
session bindings and explicit preferred accounts retain precedence. Only explicit
provider model membership and an unambiguous positive weekly window can establish
this preference. Request-time projection owns the temporary ranking; it does not
write account priorities, disable other accounts or generate extra requests.

## Alternatives considered

- Binding API requests to the currently signed-in client would couple independent runtimes and leave the intended source ambiguous among Antigravity, IDE, and CLI. It would also change existing default routing.
- Reusing experimental scheduling_mode would mix the public continuity choice with parity rollout and kill-switch behavior.
- Persisting the last leased account is unnecessary for this feature and would introduce durable account-affinity state.

- Persistently boosting account priorities would require recovery after partial
  updates, override manual choices and couple a model-specific preference to all
  models on an account. A synchronous request-time projection avoids these effects.
- Precomputing expiry at cache load would retain stale timing across waits. The
  selection reader resolves the physical model and current request time at use.

## Consequences

Prefer-the-same-account is continuity with failover, not exclusive account pinning or a cache-hit guarantee. Separate model bindings may use different accounts. Existing conversations can retain different accounts while they remain eligible. Restarting loses runtime affinity but preserves the selected strategy. Cached quota is refreshed through existing account refresh paths; display preferences never filter the API pool.

## Verification

Account selection policy tests check both parity states, cooldown/rate-limit/quota/exclusion fallback, conversation bindings, explicit preferences, account removal, resets, and unchanged rotation. account-lease-account-first.test.ts exercises real lease fulfillment with synthetic accounts, hot configuration changes, and typed refresh rejection. service-config.test.ts verifies real local RPC persistence and runtime application without changing client settings. UI tests check save failure and retry. No Google credential, official client profile, or live provider is needed.

The 2026-11-07 weekly-expiry addition received source-level review only. Tests,
type checking, governance checks and rendered UI verification are deferred under
the user's instruction; earlier verification above does not cover this addition.

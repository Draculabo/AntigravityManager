# Agent Note: Bounded Internal Endpoint Configuration

Status: implemented

Partially supersedes: [Daily endpoint priority](2026-10-04-daily-endpoint-priority.md)
for the candidate set and current regional fallback policy. Its historical live observations
remain evidence for those runs, not authority to retry current quota rejections.

## Problem

Environment overrides were split without validation, deduplication or a candidate limit.
Repeated addresses could repeat a physical request; malformed values could enter the
transport loop. Invalid routing could also be discovered after creating an explicit
cache resource. The generation Sandbox spelling differed from existing metadata routing.

## Decision

The Gemini transport owns decoding `PROXY_INTERNAL_BASE_URLS`, falling back to
`ANTIGRAVITY_INTERNAL_BASE_URLS` only when the primary variable is absent. An absent or
blank selected value keeps Daily/Sandbox/Prod defaults. Configuration is at most 8 KiB
and eight comma-separated candidates. Candidates must be absolute HTTP(S), without
credentials, query, fragment, backslash or control characters. Empty list entries fail.
URL normalization and stable deduplication preserve candidate preference; a root path
retains its slash so a method suffix cannot become a port. Custom path prefixes and
HTTP loopback fixtures remain supported.

The endpoint list is validated before history preparation or explicit cache creation,
then passed through cache downgrade and session recovery without rereading the environment.
Thinking recovery retains its existing captured transport. Invalid configuration throws a
fixed, secret-free typed error. The shared generation terminal owner releases any image
permit and stops; count stops before another lease, penalty, commit or estimated fallback.

Known Axios cancellation and local URL/option/support errors do not permit regional
failover. Recoverable transport and HTTP 408/404/5xx behavior remain; 429/499 do not gain
regional recovery permission. Public Gemini and OAuth routing are unchanged.

## Alternatives considered

- Silently dropping invalid candidates would change the operator's configured route and
  conceal a broken configuration.
- Validating only immediately before `axios.post` allows explicit cache side effects first.
- Returning the proxy-specific configuration error would misidentify the corrective action.
- A persisted endpoint registry or extra dependency is unnecessary for this environment input.

## Consequences

Operators using malformed overrides or more than eight candidates must correct them.
The same account/token remains attached to permitted endpoint failover. This candidate
bound does not bound every account/cache/session layer or establish a shared total deadline.
No database, credential location or persistence format changed.

## Verification

Public generate/count entries and protocol service checks exercise invalid/duplicate inputs,
zero-send failure, retained body/token/order, default/alias behavior, local cancellation,
no account rotation/penalty/estimate and pre-cache validation. Cache/session, real HTTP
transport, generation diagnostics, warmup and count cancellation remain neighboring checks.
Fixtures establish controlled behavior only; live hosts and installed clients are unverified.

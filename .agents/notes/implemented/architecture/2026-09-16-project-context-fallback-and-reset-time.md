# Agent Note: Project-context fallback and reset-time normalization

Status: implemented

## Problem

Google's Code Assist project-context endpoint can be unavailable at one hostname while an equivalent daily or sandbox endpoint remains available. The previous project lookup only moved from the production endpoint to sandbox for HTTP 429, which made recoverable endpoint failures block quota enrichment. Provider quota reset values can also arrive as Unix seconds or milliseconds, while the renderer previously accepted only strings understood by the JavaScript date parser.

## Decision

`GoogleAPIService.fetchProjectContext` tries Daily, Sandbox and Prod `loadCodeAssist`
endpoints in that order, matching the confirmed internal endpoint preference used by
generation, primary quota and summary lookup. It advances only after HTTP 408, HTTP 404, HTTP 429,
HTTP 5xx or a transport failure. HTTP 400, authentication failures, malformed successful
payloads and other non-retryable responses remain terminal so a bad request or credential
is not hidden by cross-host retries. This preference does not change OAuth/public endpoints
or each metadata operation's separate error policy.

Fallback logging records endpoint and status metadata only; it does not serialize raw transport error objects that may carry request configuration.

`parseQuotaResetTime` is the single renderer-side parser for quota reset values. Digit-only values of up to ten characters are Unix seconds; longer digit-only values are Unix milliseconds. Other nonempty strings continue through the native date parser. Invalid values stay unknown rather than producing a fabricated reset time.

## Alternatives considered

- Retrying every HTTP error would mask malformed requests and invalid or unauthorized credentials, while creating unnecessary external traffic.
- Preserving Prod-first metadata and Sandbox-first primary quota would keep contradictory
  operation preferences rather than the confirmed Daily/Sandbox/Prod order.
- Parsing seconds and milliseconds at each display call site would allow tooltip and relative-time displays to diverge.
- Persisting request diagnostics as part of this change was not selected. Request logging needs a separate threat model, redaction policy, retention design, and explicit product surface before it can safely record provider interactions.

## Consequences

Project lookup may issue up to three host requests for a recoverable provider outage, but does not retry permanent authentication or request errors. Existing callers retain their project-ID caching and persistence behavior because the return contract is unchanged. Quota labels and reset-time tooltips now agree for numeric provider timestamps. No credential, database schema, persistence format, or request-body logging behavior changes.

## Verification

Focused unit tests verify Daily-to-Sandbox-to-Prod, HTTP 408 and transport fallback; terminal
HTTP 400/401/403 behavior; and seconds/milliseconds reset-time parsing. Quota tests also
verify that retrieval proceeds without a project after project-context transport failures,
the same deadline/proxy snapshot survives the metadata chain, and the primary/summary
results retain their existing complete shapes. These controlled changes do not establish
live availability or change the earlier evidence limits for any host.

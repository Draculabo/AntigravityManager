# Agent Note: Project-context fallback and reset-time normalization

Status: implemented

## Problem

Google's Code Assist project-context endpoint can be unavailable at one hostname while an equivalent daily or sandbox endpoint remains available. The previous project lookup only moved from the production endpoint to sandbox for HTTP 429, which made recoverable endpoint failures block quota enrichment. Provider quota reset values can also arrive as Unix seconds or milliseconds, while the renderer previously accepted only strings understood by the JavaScript date parser.

## Decision

`GoogleAPIService.fetchProjectContext` tries the production, daily-production, and sandbox `loadCodeAssist` endpoints in that order. It advances only after HTTP 404, HTTP 429, HTTP 5xx, or a transport failure. HTTP 400, authentication failures, malformed successful payloads, and other non-retryable responses remain terminal so a bad request or credential is not hidden by cross-host retries.

Fallback logging records endpoint and status metadata only; it does not serialize raw transport error objects that may carry request configuration.

`parseQuotaResetTime` is the single renderer-side parser for quota reset values. Digit-only values of up to ten characters are Unix seconds; longer digit-only values are Unix milliseconds. Other nonempty strings continue through the native date parser. Invalid values stay unknown rather than producing a fabricated reset time.

## Alternatives considered

- Retrying every HTTP error would mask malformed requests and invalid or unauthorized credentials, while creating unnecessary external traffic.
- Preserving the old two-endpoint path would skip the daily-production host that the upstream-compatible flow uses before sandbox.
- Parsing seconds and milliseconds at each display call site would allow tooltip and relative-time displays to diverge.
- Persisting request diagnostics as part of this change was not selected. Request logging needs a separate threat model, redaction policy, retention design, and explicit product surface before it can safely record provider interactions.

## Consequences

Project lookup may issue up to three host requests for a recoverable provider outage, but does not retry permanent authentication or request errors. Existing callers retain their project-ID caching and persistence behavior because the return contract is unchanged. Quota labels and reset-time tooltips now agree for numeric provider timestamps. No credential, database schema, persistence format, or request-body logging behavior changes.

## Verification

Focused unit tests verify production-to-daily, daily-to-sandbox, and transport fallback; terminal HTTP 400/401/403 behavior; and seconds/milliseconds reset-time parsing. The existing quota-lookup test also verifies that quota retrieval proceeds without a project after all project-context transport attempts fail.

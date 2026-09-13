# Agent Note: Google Forbidden Retry Parity

Status: implemented

## Problem

Google Code Assist uses HTTP 403 for project billing context, account eligibility, identity validation and organization network policy failures. Treating every 403 identically either wastes retries on an account that cannot serve traffic or removes a usable account for a recoverable verification or VPC Service Controls condition.

Live provider checks identified two durable eligibility responses: Gemini Code Assist being unavailable in the account's location and the configured account lacking a product license (`#3501`). The captured environment evidence is recorded in [Agy and Gemini OAuth Credential Synchronization](../security/2026-08-30-agy-google-oauth-file-sync.md).

## Decision

The internal Google transport keeps `project` in the request body but never sends `x-goog-user-project` for `generateContent` or `streamGenerateContent`. It suppresses automatic project-header creation and removes any case-insensitive reinjection from model-specific or caller-supplied headers after the final merge. Content-request 403 responses therefore remain the original upstream error and do not spend a project-header downgrade retry.

Non-content internal methods retain the bounded compatibility behavior: a non-empty body project produces `x-goog-user-project`, a 403 retries once against the same endpoint without that header, and a second 403 is preserved as the final upstream error. The downgrade does not loop or trigger 403 endpoint failover.

Weekly warmup explicitly disables the project-header downgrade. Its streaming-to-non-streaming fallback remains available only for transport failures, while either an accepted HTTP 403 response or an Axios 403 rejection surfaces immediately. This keeps one warmup candidate from starting a second generation after the provider has already returned an HTTP response.

The forbidden classifier names location ineligibility and missing Code Assist license separately from a generic forbidden account. These are durable account-level failures: after the project-context downgrade is exhausted, retry policy marks the account forbidden and selects another lease while excluding accounts already attempted by the request.

Only structured `VALIDATION_REQUIRED` responses from the supported Cloud Code domains and `SECURITY_POLICY_VIOLATED` responses remain in rotation. Unrecognized 403 responses fail closed as `account_forbidden`.

## Alternatives considered

- Use a hard-coded public Google Cloud project when account project discovery fails. Rejected because it assigns billing and policy context the user did not configure and can hide provider eligibility failures.
- Retry all 403 responses across every internal endpoint. Rejected because authorization and eligibility failures are not endpoint health failures and repeated requests add latency without changing the result.
- Keep location and license failures under `account_forbidden`. Rejected because the retry action would be correct but diagnostics could not distinguish a dead credential from a provider eligibility restriction.
- Keep every recognized 403 in rotation. Rejected because location and license restrictions are durable for the current account and would repeatedly select an account known not to serve the request.
- Remove the project-header downgrade globally. Rejected because non-content internal methods retain the bounded recovery path for project-context incompatibility.
- Preserve the project header and downgrade retry for content generation. Rejected because content requests must keep project identity in the body while avoiding quota attribution through `x-goog-user-project`; a retry after the provider has already rejected the request also adds avoidable duplicate traffic.
- Preserve the downgrade for weekly warmup. Rejected because warmup has a stricter single-generation safety contract and an HTTP rejection is not a transport failure.

## Consequences

Content generation preserves its body project without sending a quota-project header, including when an extra header attempts to reintroduce it with different casing. Non-content internal methods keep one bounded project-header compatibility retry. Weekly warmup sends only one generation for an HTTP rejection, while retaining transport-failure fallback. Durable account eligibility failures rotate to another account, and the final 403 remains available when all candidate accounts fail. Identity validation and VPC Service Controls failures do not poison otherwise usable credentials.

No fallback project, credential mutation or new retry budget is introduced.

## Verification

- `npx vitest run src/tests/unit/proxy-retry-mock.test.ts --testNamePattern="GeminiClient internal request parity"`
- `npx vitest run src/tests/unit/weekly-warmup-wire.test.ts src/tests/unit/weekly-warmup-executor.test.ts src/tests/unit/gemini-count-tokens.test.ts src/tests/unit/explicit-context-cache.test.ts src/tests/unit/gemini-client-context-cache.test.ts src/tests/unit/openai-stream-disconnect-lifecycle.test.ts`
- `npm run type-check`
- `npm run check:agent-contracts`

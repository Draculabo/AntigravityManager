# Agent Note: Classified Metadata Failover and Project Downgrade

Status: implemented

Partially supersedes: [Quota summary Hub identity](2026-10-24-quota-summary-hub-identity.md)
for error traversal and project removal only. Its identity, group matching and historical
live acceptance remain active.

## Problem

The original D10 decision requires per-operation metadata error classes. The later Hub
summary change instead advanced after every rejection except 401 and removed project
for any 403, resetting that permission at each host. Unknown account/location denials
could therefore trigger unrelated requests and repeated identity changes. A malformed
successful summary was also treated as transport failure.

## Decision

Project context advances on network errors and HTTP 408/404/429/5xx; primary model quota
retains network/429/5xx traversal. Summary advances on network/408/429/5xx and ends on
other unsuccessful statuses. Invalid successful summary data ends optional enrichment.
Successful primary quota is retained in either summary failure case.

The shared auth boundary decodes project denials with Zod for cloud-account metadata and
Gemini internal metadata/count transport. Only Google ErrorInfo
details with `domain: googleapis.com`, reason `USER_PROJECT_DENIED` or `BILLING_DISABLED`,
and consumer matching the submitted project permit a no-project lookup. Every supplied
detail must satisfy this narrow contract. Missing, unknown or mismatched details do not
permit downgrade. A name/number mismatch is not inferred to identify the same project.
The standard shape is documented by Google's
[error reason definition](https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto);
internal endpoint emission remains unverified.

Both model quota and summary already support omitted project. Removal is retained across
hosts and passed from model quota to summary, so a logical refresh can remove project
only once. The OAuth identity, proxy snapshot and shared deadline remain unchanged.
Gemini transport permits header removal only for `loadCodeAssist`, `fetchAvailableModels`,
`retrieveUserQuotaSummary` and `countTokens`, with the same matching denial. Resolved raw
HTTP and Axios rejection share the rule. Raw JSON errors have a 64 KiB decode ceiling.
Other diagnostic verbs, ambiguous project-header values and unknown errors cannot downgrade.
All header casings are removed on the one permitted retry, while body.project and other
headers remain. Generation still omits the quota-project header; it does not acquire a new
body-project downgrade through this policy.

## Alternatives considered

- Retaining broad 4xx traversal contradicts the confirmed original D10 policy and cannot
  distinguish deployment rejection from account permission failure.
- Matching prose such as "project" or "permission" would classify unrelated denials as
  recovery permission. Structured unknown errors are deliberately terminal.
- Resolving project aliases or probing account permissions would add network calls and
  ownership outside this bounded metadata operation.
- The second real consumer justifies sharing the strict denial decoder, rather than
  deep-importing another feature or sharing operation-specific eligibility and retry state.

## Consequences

Optional grouped quota may be missing sooner for host-specific permanent rejection;
stored quota merge/freshness behavior remains owned by existing observation logic.
There are at most four summary attempts: one per host plus one identified downgrade,
and fewer if the primary operation already removed project. No durable format changed.

## Verification

Public service methods through the Axios fixture cover permanent and transient status
classes, structured versus unknown denial, consumer/domain mismatch, persistent downgrade,
primary-to-summary propagation, malformed success and project-context 408. Gemini checks
also cover raw/rejected HTTP, string JSON, unsupported verbs, repeated denial, injected
header casing, ambiguous values and downgrade persistence through endpoint failover. Existing
deadline, cancellation, proxy snapshot, subscription and Hub identity checks remain in
the neighboring selection. Controlled fixtures establish policy, not live provider support.

# Upgrade guide: Check token count coverage and source

Target version: next

## Affected users

Anthropic count callers now receive a complete local estimate by default, with reason
`anthropic-local`, without selecting a provider account or making an upstream request.
Gemini count callers whose input includes system instructions or tool
declarations/configuration receive an explicitly estimated complete count when the internal
upstream endpoint only counted contents. Operational fallback for locally unestimated media,
such as PDF, video, remote media or audio without verified duration, now fails with 503
instead of publishing a partial total.

## Required action

1. Read `X-AGM-Count-Tokens-Source` where your client exposes response headers. The value
   `estimated` denotes a gateway heuristic; `upstream-contents-only` explains a coverage gap.
2. Keep generation usage/billing separate from count estimates. Do not treat this estimate
   as an exact model-window or automatic-compaction threshold.
3. For a 503 indicating unavailable local media coverage, retry upstream counting later or
   simplify the count input. Do not interpret it as a zero-token prompt.

## Data and recovery

No durable data, credentials or configuration is migrated. Valid nonnegative safe integer
upstream counts, including zero, remain supported. Invalid upstream values follow the
existing unavailable-count policy. Local coverage failure after a valid count does not
retry or penalize that healthy account. Native Gemini cancellation does not become an
estimated success or accept a late count.

Anthropic local counting still requires proxy authentication and admitted inputs. It does
not establish provider access and can work with no configured provider account. Unknown
media coverage is an explicit 503; a local count never commits account affinity or changes
account health. Clients that require a provider-measured count must not substitute this
local estimate for one.

## Downgrade

No storage restoration is required. Older versions can mislabel a contents-only count as
complete, accept invalid numbers or return incomplete media estimates. Client code relying
on source headers must account for the version's behavior; downgrade does not reconstruct
an exact full-input provider count.

## Verification

Controlled service/controller checks cover invalid numbers, valid zero, complete system/tool
source reporting, unavailable PDF estimates, no account effects from local coverage errors
and cancellation neighbors. See the [compatibility reference](../../modules/proxy-gateway/compatibility.md)
and [decision](../../../.agents/notes/implemented/protocol/2026-11-05-count-value-and-coverage.md).
No provider tokenization equivalence, live count endpoint or installed SDK behavior was verified.

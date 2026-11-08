# Upgrade guide: Retain preceding tool calls with their results

Target version: next

## Affected users

Anthropic Messages, OpenAI Chat and Responses clients that replay tool results without their
preceding calls, repeat an already consumed result, or reuse an ID while its earlier
call is still pending now receive HTTP 400. Tool calls must belong to assistant
messages and tool results to user messages in the intermediate Claude history.
Clients retaining unambiguous history can upgrade normally on every platform.

Native Gemini generation also rejects a `functionResponse.name` that differs from its
pending `functionCall.name`, even when the response has the correct ID or is the sole
pending result. The error names its position and `conflicting-result-name`, without
including the function arguments or result payload.

Chat, Responses, Messages and native Gemini generation also reject an empty or
whitespace-only business request, initial-system-only history, an unanchored
assistant start and a call without its result. Responses no longer converts a
terminal assistant message into a user message. Count-token requests retain
their separate behavior.

## Required action

1. Keep each result together with its preceding assistant call when trimming history.
2. Give parallel calls distinct IDs, even when they invoke the same tool name.
3. On `invalid_request_error`, correct the indicated message/block position or start
   a new conversation with an accurate summary of completed work. Do not repeat a
   tool merely to reconstruct history.
4. Send an actual user request for a new conversation. For an anchored assistant
   prefill, retain its original role and text. The Gemini generation adapter adds
   a temporary continuation only where needed; do not add it to persisted history.
5. Preserve actual tool results and signed history after a signature rejection.
   The gateway no longer guesses completion/interruption or retries a rewritten
   conversation. Recover the original history or start a fresh accurate summary.
6. For native Gemini, retain the original function name on its response. Do not rename
   a result to another function merely because its call ID is unchanged.

Completed IDs can still be reused in a later round. No application stop, configuration
conversion or manual profile edit is required.

Responses retains complete leading tool exchanges. If compaction removes calls and
multiple cached calls share a reused ID, send the correct original call with its result
or start a fresh summarized conversation. The gateway cannot infer the intended round
from that ID alone. Replayed durable item IDs must identify identical payloads; do not
reuse an item ID for a different call. Unidentified results are not silently discarded.

Responses calls missing an ID receive a deterministic ID instead of a timestamp. Keep
the assigned ID when replaying them. A result that also omits its ID can match only one
pending preceding call; parallel pending calls require explicit result IDs. Generated IDs
are retained before media sanitization, using the existing optional `call_id` field.
There is no profile conversion or manual file editing.

## Data and recovery

Persisted data and credentials are unaffected. Invalid histories are rejected without
upstream dispatch, tool execution or account penalty. Generation history admission
occurs before leasing. Existing files are retained, but missing calls cannot be reconstructed
from result IDs or names alone. Repair client history from its original evidence.
Responses validates its effective history before account selection. Cached calls remain
plain JSON arrays in the existing durable format; no schema or encryption migration occurs.
Previously discarded cache variants are not recoverable from the old cache alone.

## Downgrade

There is no durable format conversion to undo. Older code reads the same stored data,
but may resume its former ambiguous association and orphan-result fallback behavior.
Application downgrade against an actual user profile has not been exercised.

## Verification

Controlled mapper and protocol-path tests cover parallel same-name calls, completed ID
reuse, duplicate pending IDs, orphan and repeated results, role errors, HTTP errors,
and no dispatch, retry or penalty. Live provider and installed-client checks remain
deferred. See the [compatibility reference](../../modules/proxy-gateway/compatibility.md#tool-result-association)
and [decision](../../../.agents/notes/implemented/bug-fix/2026-10-18-tool-result-association.md).

The generation history checks exercise Responses input conversion, prefill in unary
and streaming requests, cancellation before admission, and count-token requests
without a generation continuation. They also check that the original requests stay
intact. See the
[generation history tests](../../../src/tests/unit/generation-history-admission.test.ts).

Actual application downgrade, client replay and live-provider signature acceptance
remain unverified.

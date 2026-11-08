# Upgrade guide: Size the complete generation timeout

Target version: next

## Affected users

OpenAI Chat/Responses, legacy completions, image generation/edit, Anthropic Messages and native Gemini callers whose generation
requires account/endpoint retries, preparation, recovery or slow/paused streamed output.

## Required action

Treat `request_timeout` as the generation service's complete time budget. If the intended
operation legitimately takes longer, adjust that existing setting to the required total.
Do not assume each fallback receives another full timeout. Handle HTTP 504 or the protocol's
terminal stream failure; do not automatically replay a partially executed tool request.

## Data and recovery

No persisted data or credential migration is required. The gateway cancels active transport
and releases waiters, timers and image permits at the deadline. Shared cache/SQLite work
retains its own cleanup contract; remote cache creation may have an unknown outcome.
Main HTTP generation file/Responses-history expansion consumes this same budget.
Responses WebSocket preparation consumes the per-message budget after dispatch. Queue
residence and HTTP body/multipart parsing retain their existing owners. Legacy completion
dispatch and streaming consume one budget. Image generation/edit dispatch and native Gemini
protocol fallback share their original budget, including time spent in the first protocol.
A response save admitted before timeout can still complete. Timeout does
not establish absence of a saved response. Retry only when safe for the partial effects.

## Downgrade

Older releases may reset physical timeouts across fallback layers. No storage restoration
is needed, but downgrading does not prove a timed-out remote operation did not run or bill.

## Verification

Controlled service/transport checks and an isolated real HTTP upstream cover deadline
expiry and cleanup. Installed/live-provider recovery and platform-pressure behavior are
unverified. See [compatibility](../../modules/proxy-gateway/compatibility.md) and the
[decision](../../../.agents/notes/implemented/bug-fix/2026-11-05-generation-total-deadline.md).

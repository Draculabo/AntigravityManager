# Upgrade guide: Start fresh Responses conversations after the history format reset

Target version: next

Status: implemented with controlled validation; real-provider, installed-client and
final domain acceptance remain deferred. This guide describes the upcoming upgrade
boundary and does not claim release publication.

## Affected users

All platforms with records in `openai-responses-sessions.json` are affected. Earlier records
do not retain the current caller ownership and initial task identity together. The user accepts
replacing those records without migration. New Chat Completions requests without Responses
cursors are unaffected. Existing proxy credentials, account credentials and database schemas
are unchanged.

## Required action

1. Stop the gateway normally before upgrading. If offline recovery or downgrade matters,
   make a copy of `openai-responses-sessions.json` while the gateway is stopped; the
   application does not create this copy.
2. Upgrade and start the gateway. On its first Responses store access, the strict current
   decoder rejects old records and atomically replaces the active file. Create a new
   Responses conversation instead of continuing an old cursor. A client may resend history
   it already holds as new input; the server does not assign ownership or initial identity
   to old records.
3. Use the same accepted proxy credential to read, delete or continue new records.
   Equivalent Bearer and API-key headers work. Changing the credential creates a
   different caller identity; new records remain subject to normal capacity/expiry.

This feature adds no encryption. The active history file contains plaintext conversation
content; only a one-way credential digest is retained for ownership, not the raw key. An
unknown creator is recorded internally as `unknown`, not assigned a default owner.

## Data and recovery

The active path remains `openai-responses-sessions.json`. No migration, compatibility reader,
backup or older-filename fallback is used. The first store access drops entries rejected by
the current decoder and writes the current-format entries atomically; old response IDs then
return not found. A separate `openai-responses-sessions.v2.json`, if present, is ignored and
left untouched.

Missing, expired, foreign and unknown-owner HTTP cursors return the existing not-found
envelope. WebSocket durable-history admission rejects an unavailable cursor. Rejection
does not claim ownership, delete another caller's record, renew its retention or call
the model. It does not prevent the actual owner from continuing a retained new record.

Atomic writes retain the existing fail-open policy: a failed replacement is logged and
may leave new history available only in memory while the prior file bytes remain in place.
Restart cannot recover an unsaved record. The application does not create a migration backup.
Do not copy old records into the active file or edit owner digests to bypass admission. To
restore pre-cutover history, stop the gateway and restore a copy made before the reset;
unknown or corrupt ownership or initial identity is not repaired automatically.

## Downgrade

An older binary may reject the new record format in the reused file and replace it with its
own empty or legacy format. Downgrade cannot recover replaced conversations unless a copy
was made before the cutover. Restore that copy before starting an older binary if the old
cursors are needed. Older formats also lack current caller and initial-identity checks;
downgrade does not preserve those guarantees. No database downgrade is required.

## Verification

Synthetic checks for the completed v2 ownership slice passed 283 tests in 28 files,
with zero failures or pending cases. They covered caller isolation,
continuation/read/delete, equivalent headers, anonymous identity, unknown ownership,
parent chains, restart, cancellation, injected write failure and preservation of the
original file. Type, focused lint/formatting, runtime/type boundaries and Agent
contracts passed for that slice. An earlier retention result had intermittent behavior;
later investigation captured a Windows `EPERM` during atomic replacement, while the
conflicting handle owner remains unidentified.

The current validation adds isolated checks that old active entries are discarded,
older filenames are ignored, current records survive restart, and a failed atomic
replacement leaves the prior bytes intact. Real profiles/providers and final domain
acceptance remain deferred; these checks do not establish real-profile, installed-client
or cross-platform acceptance.

Current behavior is owned by the [gateway security reference](../../modules/proxy-gateway/security.md#responses-history-ownership)
and the [decision record](../../../.agents/notes/implemented/security/2026-10-17-responses-history-tenant-ownership.md).

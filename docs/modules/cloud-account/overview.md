# Cloud Account Module

The `cloud-account` module owns the managed Google account pool, quota refresh and display,
automatic switching policy, account import, and optional weekly warmup. Its desktop feature
surfaces live under `src/modules/cloud-account/`.

## Account pool and quota

Users can add and import Google accounts, refresh account tokens and quota, inspect account
status, and remove accounts from Manager. Removing an account also removes saved current-account
references that point to it; it does not sign that account out of an official client or select a
replacement. Startup cleanup removes stale references without switching clients. Account deletion
and reference cleanup share a SQLite transaction, so cleanup failure rolls back the deletion.

Quota views can show five-hour, weekly, or combined windows, with the combined view as the default.
Gemini and Claude visibility is configured independently for each window and applies to normal,
list, compact, and provider-grouped cards. These controls filter presentation only: they do not
change stored quota snapshots, account scores, warmup eligibility, automatic switching, or proxy
account selection. Claude visibility also covers GPT/third-party (`3p`) buckets; unclassified or
shared groups remain visible.

The weekly view includes provider buckets whose `window` or `bucket_id` contains `week`, without
substituting model quota when those buckets are missing. The five-hour view retains non-weekly
detailed buckets.

Grouped quota comes from the Cloud Code quota summary. Manager requests it from the Daily host,
then production, then sandbox, and moves to the next host after any rejection except HTTP 401.
The summary request identifies itself as the Antigravity app's `hub` client, because Google does
not return model-specific groups such as Gemini 4 Argon to the bare client identity; model quota
requests keep the existing client identity. A group named exactly after one registered model family, such as
Gemini 4 Argon on Google AI Pro, limits only that family. It is displayed like any other group
(Gemini 4 Argon has only a weekly bucket, so it appears only in the weekly view), but scores,
recommendations and automatic switching for models of other families ignore it.

## Automatic switching

The account monitor polls quota every five minutes by default. With automatic switching enabled,
the module can switch official Antigravity clients when the active account is rate-limited or when
all key model quotas or applicable shared quota buckets fall below 5%. The client toolbar controls
this behavior. It does not choose the account used by proxy API requests; that policy belongs to
the [proxy gateway](../proxy-gateway/compatibility.md).

Client switching crosses into `antigravity-runtime`, which owns process lifecycle and writes to
client credential stores. Follow the [account switching acceptance tutorial](../antigravity-runtime/account-switch-acceptance.md)
for real CLI and Electron evidence. Failure state and recovery expectations are defined in
[failure ownership](../../error-handling.md).

## Weekly warmup

Weekly warmup is off by default and is configured under Settings > Models. Enabling it keeps the
existing five-minute monitor running when automatic switching is off. Only successful fresh quota
or token refreshes, including manual refreshes, provide candidates. While warmup is enabled, the
visible account list rereads local snapshots every minute; this renderer refresh does not call the
provider.

Eligibility requires a Google account without a non-active status or forbidden quota flag, at
least `0.999` remaining fraction, and a valid reset timestamp that passed less than six days ago.
The selected Gemini or Claude group must be enabled. Weekly requests use `gemini-3-flash` or
`claude-sonnet-4-6` as the representative model. A group dedicated to one model family is warmed
only when the representative model belongs to that family, so Gemini 4 Argon is not warmed.
Missing weekly groups and unavailable project context are not replaced with guessed values.

Warmup consumes real model quota and may use AI credits. An accepted HTTP response is recorded as
success; it does not prove that the provider restarted a weekly timer or completed generation. The
application rereads quota after successful warmups, and it makes no live-provider timer or cost
guarantee.

`WeeklyWarmupService` owns a serial main-process queue shared by scheduled and manual refreshes.
There is a two-second delay between candidates. Configuration changes and monitor shutdown cancel
the active generation request and prevent queued candidates from starting. An already accepted
provider request cannot be undone.

Failed requests do not create success records and can be retried after a later fresh refresh.
Invalid or unreadable history, or a history write failure after provider acceptance, pauses warmup
until application restart. Repair the underlying storage problem before restarting; otherwise the
safety check pauses it again. Invalid configuration remains an error in Settings instead of being
silently replaced with enabled defaults. A process crash after provider acceptance but before
history persistence can cause another request after restart; execution is not exactly-once.

The module stores validated warmup configuration and versioned history in existing settings rows;
it does not add a database schema. History keys contain account ID, bucket ID, weekly window, and a
normalized reset timestamp. Equivalent timestamp offsets and legacy string timestamps resolve to
the same key. Successful entries are retained for 30 days, and older reset cycles remain excluded
after retention cleanup.

The proxy-gateway adapter uses the existing Claude mapper or native Gemini request envelope and
`GeminiClient` transport. It first requests `streamGenerateContent?alt=sse`, then falls back to
`generateContent` on transport failure; it does not repeat an HTTP rejection as a non-streaming
request. Content requests preserve the project in the body but omit `x-goog-user-project`, including
after extra headers are merged. Non-content internal methods retain the bounded Google 403
project-header downgrade. A 60-second deadline and cancellation signal bound transport work. No
internal HTTP endpoint or authentication bypass is exposed.

## Persistence and security

Cloud account credentials are stored in the local application profile database. The
[account storage contract](security.md#account-storage-and-conversion) owns the representation, conversion backup and recovery
policy. Do not put account tokens in logs, reports, IPC diagnostics, screenshots, or test fixtures.

## Related references

- [Cloud-account security](security.md): storage conversion, OAuth sessions, strict public views,
  imports/exports and background-operation boundaries.
- [Architecture and module boundaries](../../architecture.md#feature-ownership)
- [Identity profile and desktop storage initialization](../identity-profile/overview.md)
- [Testing strategy](../../testing.md)
- [Failure ownership and recovery](../../error-handling.md)

## Focused persistence checks

For cloud-account plaintext storage, run the focused mock tests with `pnpm test --run
src/tests/unit/convert-encrypted-account-fields.test.ts
src/tests/unit/cloud-account-batch-writer.test.ts`. The real SQLite reopen and old-ciphertext backup
test needs the installed Electron ABI on Windows:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& .\node_modules\electron\dist\electron.exe .\node_modules\vitest\vitest.mjs run src/tests/unit/cloud-account-plaintext-persistence.test.ts
```

`cloud-account-plaintext-persistence.test.ts` exercises real SQLite account deletion, current-account
reference cleanup at startup, repeat deletion, unrelated-setting preservation and transaction rollback
using disposable databases. Run it with `cloud-account-settings-store.test.ts`,
`cloud-account-adapter.test.ts`, `core-rpc.test.ts` and `convert-encrypted-account-fields.test.ts`
for the adjacent desktop and standalone contracts. When the workspace SQLite binary was rebuilt
for Electron, run the same Vitest entry with the matching Electron executable and
`ELECTRON_RUN_AS_NODE=1`; do not rebuild it for Node over the desktop binary just to run these tests.
This establishes native persistence behavior, not installed-client sign-out or live-provider requests.

# Cloud Account Security Contracts

This reference owns account storage, OAuth enrollment and account-operation transport. See [global security rules](../../security.md) and [diagnostic privacy](../../security/diagnostics.md).

## Account storage and conversion

The `accounts` table stores `token_json`, `quota_json` and `health_json` as plaintext JSON. The
token field includes OAuth access and refresh tokens and may include an ID token or upstream proxy
URL. Account CRUD and ordinary startup do not use the account-encryption master key. On startup,
only databases containing older encrypted account fields invoke the existing key providers. The
owner validates every decrypted field, creates an SQLite backup beside the database, then writes
all converted fields in one transaction. A missing key, invalid field or failed backup stops startup
without changing account rows. The encrypted backup remains available for manual recovery.
If a standalone core cannot access the old key provider, start the desktop once with the same
profile to perform conversion, then start the core. A failed core attempt leaves rows unchanged.

## OAuth enrollment and client selection

Google login in both the standalone core and Electron main uses a loopback-only callback listener
owned by the account runtime. Each
session has a random single-use OAuth state, a bounded lifetime and an exact redirect URI shared
by authorization and token exchange. In standalone mode, the local management endpoint returns
only the authorization URL, session ID, session state and a safe account summary; callback
codes and tokens stay in the core. A callback with a missing or incorrect state cannot enroll an account. The listener
closes before the core releases profile ownership, and shutdown rejects new sessions before
waiting for any in-flight start. The detached CLI launcher does not forward custom OAuth client
secrets, so `account login` uses the core's active/default client without a client-selection flag.
The printed URL must be opened in a browser on the same machine because its redirect target is
`127.0.0.1`.

The desktop opens its authorization URL in the system browser after validating its trusted Google
origin. Its renderer RPC returns only a strict cloud-account view or a stable, value-free failure
category. The manual fallback accepts a user-pasted authorization code through a strict, bounded
renderer request only while a login is pending. The selected owner exchanges it with the session's
exact client and redirect URI; the code is neither persisted nor logged, and no code appears in a
response or presentation event. Callback and manual completion consume the same session at most
once. Authorization URLs, session IDs, CSRF state, automatically received callback codes and tokens never cross the
preload/renderer boundary. In remote adapter mode, the private management endpoint starts and
polls the core-owned session; its optional bounded OAuth client key is captured in the same start
request. Its manual completion endpoint accepts only a bounded code for a live session. Electron persists the selected preference through core RPC, then passes the explicit key
to session start so another preference change cannot alter the exchange client. A desktop failure
or quit cancels only its pending core session; cancellation never interrupts an enrollment already
admitted by the core. The former fixed-port callback listener and renderer code-delivery channel
are removed. Embedded desktop shutdown waits for accepted enrollment before gateway teardown,
subject to the bounded forced-exit timeout.

OAuth client discovery and active-client preference use strict public descriptors containing
only the key, label, client ID and active/builtin flags. Client secrets and registry internals
remain inside the owning process. Both renderer and core RPC validate bounded client keys;
unknown keys produce a value-free error, and malformed environment entries or invalid saved
preferences are logged without their raw values. Preference changes persist through the
existing `active_oauth_client_key` setting. Electron currently selects embedded account ownership.

## Account operations and public views

Switch diagnostic transport exposes strict closed variants, finite counters/timestamps, a volatile owner-process epoch and bounded guard entries. Recent failure messages are replaced with fixed public text; raw instrumentation errors and unexpected hardening stages cannot cross this boundary. Remote diagnostic failure never substitutes Electron-local state.

Cloud-account switch failure logs include the owner stage, target, resolved storage, flow failure
reason and an allowlisted diagnostic error code. Arbitrary native/provider codes and causes are
not included in that record. Public switch errors keep their fixed message and existing category.
Sentry attaches recent logger entries as formatted strings so the SDK's default normalization
depth preserves their text. These strings and the logger message redact common inline credential
forms, encoded keyring payloads, email addresses and local user-directory names before capture;
the account-load bug report uses the same text redactor.

Manual quota refresh validates a bounded account ID on the core RPC boundary and returns only
the strict cloud-account view. Provider errors and internal account fields are not serialized to
the caller. The core schedules weekly warmups only after successful refresh paths; shutdown
cancels and drains those tasks before persistence teardown. The local transport uses a separate
bounded timeout for this multi-request operation.

IDE account sync reads local IDE state only in the process that owns account persistence. The
renderer and private core RPC receive a strict account view or null, and sync failures expose a
small validated error category. Raw provider messages, local database paths, tokens and stacks
stay inside the owning process. Shutdown drains admitted sync work before releasing the profile
lease. The long-running account mutation client uses the same bounded transport timeout as quota
refresh.

Cloud-account switching accepts a bounded account ID and an enumerated target through both
renderer and private core RPC. The selected owner performs token refresh, process control and
credential injection; no token, device profile or target database path crosses either boundary.
The renderer receives only a stable failure category, never the provider or storage error. Core
shutdown drains admitted switches before releasing persistence. Desktop shutdown rejects new
switches and waits for admitted work within its bounded forced-exit window; a switch exceeding
that window can be interrupted by process exit and must be retried after restart.

The renderer reads account security status from the selected persistence owner, so remote mode
reports the standalone core's key-storage state. The account owner resolves validation links
from stored health data and returns only a bounded, normalized `https://accounts.google.com`
URL over the private core RPC. Electron main validates the returned URL again before invoking
the system browser. The renderer receives no URL; failures expose only stable categories and
never include stored URLs, account tokens or internal diagnostics.

The Electron cloud-account list and account-returning mutations project a strict renderer view
before the MessagePort response. The view includes display metadata, UI quota fields, active flags and
bounded health signals, but excludes tokens, device profiles, raw provider status reasons,
verification links, proxy URLs and gateway-only quota policy fields. The card displays only whether a proxy is configured;
replacing or removing it uses the existing account-scoped mutation. Account export and identity
profile operations remain separate, explicitly invoked capabilities with their own contracts.

## Import, export and background effects

Local-import credential sessions remain in the selected owner. UUID capabilities carry no credential payload and are consumed once before persistence. Desktop capability affinity rejects sessions from a replaced adapter; core restart loses the old session namespace. Preview/result transport bounds every nested array, metadata string, count and timestamp, and rejects unknown fields. Owner shutdown clears reusable credential sessions and prevents late preview completion from reopening them. Remote failures return stable categories and cannot execute the embedded importer.

Owner presentation hints contain only validated account IDs, closed event/target/language variants, bounded model IDs and finite credit values. They contain no account records, credentials, paths, provider diagnostics or arbitrary messages. A strict private read-only endpoint exposes bounded batches to Electron main; display metadata is separately resolved through strict account views. Unknown event variants fail closed. Presentation delivery is best effort, in memory only, and cannot change persisted owner results or trigger mutation retries.

Monitor controls return only strict configuration or a void/success result. Polling and auto-switch retain full accounts only inside their owner. Private configuration writes stay within a 3,000-byte encoded model-policy bound without increasing the shared 4 KiB request cap; saved reads retain a separately bounded compatible shape. Weekly-warmup transport validates its group list independently from the existing durable codec. Monitor failures become one value-free category at both transports. Desktop notifications are local effects; the standalone core emits no notification payload through the renderer.

Cloud-account file import/export keeps token-bearing documents inside the account owner. Only Electron main selects paths; the private core endpoint accepts a bounded path and validated operation options, while the renderer accepts neither paths nor document contents. Full backups intentionally contain account tokens and configured proxy credentials on disk; stripped backups omit account tokens but retain the existing proxy/profile compatibility format. Export uses atomic replacement with restrictive POSIX permissions. Import rejects files above 5 MiB and returns bounded failure categories with validated email metadata, without provider, filesystem or database diagnostics. The shared private-RPC request and response limits are unchanged.

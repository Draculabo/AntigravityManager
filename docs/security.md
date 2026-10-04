# Security and Data Boundaries

This document defines the security-sensitive boundaries that repository changes must preserve. Read it before changing preload exposure, IPC, credentials, logging, persistence, proxy authentication, updates or external process execution.

## Trust model

- Electron main, preload and renderer are separate trust zones.
- The renderer receives only APIs explicitly exposed through `contextBridge` in [src/preload.ts](../src/preload.ts).
- IPC/ORPC, HTTP, filesystem, database, process, worker and deserialization inputs are runtime boundaries and require validation before trusted use.
- TypeScript types alone are sufficient only for typed values that never crossed a runtime boundary.

Do not expose general-purpose filesystem, process execution, Electron IPC or credential APIs to the renderer. New preload methods must be narrow, typed and backed by an allowlisted main-process operation.

Traffic events received by the preload are synchronously validated with Zod's per-parse
`jitless` option before reaching renderer callbacks. Zod can initialize before the page's
Content Security Policy takes effect; a cached permission to compile JavaScript must not
cause later event parsing to attempt dynamic compilation. The page keeps its existing
no-eval policy, and invalid events do not reach subscribers. This option is local to the
preload event boundary and does not change Zod configuration in other processes.

## Sensitive data

Cloud-account load errors offer an explicit bug-report action. It copies the app, OS, architecture,
Electron and Node versions together with the available error details to the clipboard, then opens
the GitHub bug template without report contents in its URL. The environment endpoint excludes
hostname, network addresses and account identifiers. The report masks common credential forms,
email addresses and user-directory names; it does not read account records or log files. Users
paste the report and submit it themselves. Clipboard failure prevents opening the form; browser
failure preserves the copied report and provides the form URL for manual continuation.

Remote desktop bootstrap verifies core compatibility, readiness, PID, epoch and a profile
fingerprint against the profile-owner probe before enabling owner operations. The fingerprint
is identity metadata, not authentication; the existing private pipe/socket permissions remain the
access boundary. Epoch headers reject requests to replacement processes before side effects,
including OAuth and shutdown. Handshake/startup failures expose fixed errors, without paths,
credential material or arbitrary provider diagnostics. Remote startup never opens local owner
persistence as recovery.

Private remote IPC capture accepts prepared audit chunks only from the owned main-process
incremental redactor. It does not expose a raw provider-body upload API to the renderer. The core
validates epoch capabilities, canonical encoding, chunk order and size, cumulative storage and
final accounting; complete nonoversized hashes are checked against received bytes. Full oversized
hashes are trusted producer metadata because discarded suffixes are never transmitted. Capture
metadata uses the same canonical chunk validation and an aggregate retention budget. Error summaries
come from the existing owned redactor, not raw exception transport; public RPC errors retain fixed
messages. Preparing capabilities cannot run business operations, and completed input fields cannot
be rewritten. Reservations are released on retirement, including abandoned preparation. Capability
headers carry no credentials and are valid only in the current owner process. See the
[runtime topology](architecture.md#runtime-topology) for bounds and current cutover gates.

Legacy local-account transport contains bounded account/identity metadata and closed error categories, without backup paths, raw database rows or credential-bearing backup objects. Snapshot restore accepts an account ID and reads its existing backup only inside the selected owner. The unused raw backup/restore renderer contracts are removed; internal durable backup codecs and native injection policy remain unchanged. Admission/drain covers both reads and serialized writes, and existing database primitives close their per-operation handles in `finally` blocks.

Configuration snapshots expose bounded runtime/proxy fields and secret-presence metadata, excluding API keys and upstream proxy URLs. Explicit reveal is the only secret-bearing read; the renderer keeps its result in local interaction state rather than query caches. Secret writes use separately validated bounded input. Configuration routes are excluded from audit middleware so reveal/write payloads cannot initialize audit workers or enter admin-operation logs. Transport/service errors use value-free categories.

Only `/rpc/serviceConfig/update` and `/rpc/openCode/sync` have a 128 KiB allowance plus envelope overhead, each with a separate encoded schema bound. Other private RPC requests retain the 4 KiB limit, including secret writes with a 3,000-byte encoded bound. Desktop preferences contain no proxy credentials and use atomic versioned storage; corrupt preferences fail closed without reseeding legacy privacy consent. The existing service configuration file format and secret-storage behavior are unchanged.

OpenCode refresh grants remain inside the selected owner and its existing external plugin account file; this integration does not introduce a Manager-side token-refresh mechanism. Normal responses contain strict status, intentional current configuration location metadata or a bounded redacted preview. Backup contents, backup/temporary locations, OAuth grants and dedicated keys do not cross control transport. OpenCode renderer routes bypass audit middleware. Configuration, local-account and OpenCode public errors preserve only validated closed categories and fixed messages; their IPC error logs omit raw input, values, causes and stacks. External plugin formats, account selection, backup recovery and native dedicated-key storage remain unchanged.

Audit file export keeps body contents and destination paths outside renderer responses. Only the trusted desktop chooser supplies a bounded absolute destination; private input is independently bounded to 3,000 encoded bytes. The selected owner enforces the existing 100 MiB body ceiling while streaming, uses a new sibling temporary file with restrictive POSIX permissions and preserves the prior destination on failure before replacement. Parent-directory synchronization errors after replacement indicate uncertain durability rather than rollback. Export failures expose fixed text without filesystem/provider diagnostics. The desktop retains its creating adapter throughout selection and does not use embedded persistence on remote failure.

Switch diagnostic transport exposes strict closed variants, finite counters/timestamps, a volatile owner-process epoch and bounded guard entries. Recent failure messages are replaced with fixed public text; raw instrumentation errors and unexpected hardening stages cannot cross this boundary. Remote diagnostic failure never substitutes Electron-local state.

Local-import credential sessions remain in the selected owner. UUID capabilities carry no credential payload and are consumed once before persistence. Desktop capability affinity rejects sessions from a replaced adapter; core restart loses the old session namespace. Preview/result transport bounds every nested array, metadata string, count and timestamp, and rejects unknown fields. Owner shutdown clears reusable credential sessions and prevents late preview completion from reopening them. Remote failures return stable categories and cannot execute the embedded importer.

Owner presentation hints contain only validated account IDs, closed event/target/language variants, bounded model IDs and finite credit values. They contain no account records, credentials, paths, provider diagnostics or arbitrary messages. A strict private read-only endpoint exposes bounded batches to Electron main; display metadata is separately resolved through strict account views. Unknown event variants fail closed. Presentation delivery is best effort, in memory only, and cannot change persisted owner results or trigger mutation retries.

Monitor controls return only strict configuration or a void/success result. Polling and auto-switch retain full accounts only inside their owner. Private configuration writes stay within a 3,000-byte encoded model-policy bound without increasing the shared 4 KiB request cap; saved reads retain a separately bounded compatible shape. Weekly-warmup transport validates its group list independently from the existing durable codec. Monitor failures become one value-free category at both transports. Desktop notifications are local effects; the standalone core emits no notification payload through the renderer.

Cloud-account file import/export keeps token-bearing documents inside the account owner. Only Electron main selects paths; the private core endpoint accepts a bounded path and validated operation options, while the renderer accepts neither paths nor document contents. Full backups intentionally contain account tokens and configured proxy credentials on disk; stripped backups omit account tokens but retain the existing proxy/profile compatibility format. Export uses atomic replacement with restrictive POSIX permissions. Import rejects files above 5 MiB and returns bounded failure categories with validated email metadata, without provider, filesystem or database diagnostics. The shared private-RPC request and response limits are unchanged.

Sensitive data includes access and refresh tokens, API keys, authorization headers, session secrets, credential payloads, account recovery material and any value that can be exchanged for account access.

- Cloud-account OAuth tokens are stored as JSON in the user's local SQLite database. Protect the
  profile directory and its backups with OS account permissions; anyone able to read the database
  can read those tokens.
- Other credential stores retain their existing keyring or encrypted-storage policies.
- Do not put credentials in logs, test fixtures or diagnostic snapshots.
- Do not copy production credentials into tests, bug reports or Agent Notes.

The `accounts` table stores `token_json`, `quota_json` and `health_json` as plaintext JSON. The
token field includes OAuth access and refresh tokens and may include an ID token or upstream proxy
URL. Account CRUD and ordinary startup do not use the account-encryption master key. On startup,
only databases containing older encrypted account fields invoke the existing key providers. The
owner validates every decrypted field, creates an SQLite backup beside the database, then writes
all converted fields in one transaction. A missing key, invalid field or failed backup stops startup
without changing account rows. The encrypted backup remains available for manual recovery.
If a standalone core cannot access the old key provider, start the desktop once with the same
profile to perform conversion, then start the core. A failed core attempt leaves rows unchanged.

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

Core application RPC shares the private management pipe/socket and has no TCP listener. It
accepts calls only while the standalone core is running, bounds client requests and responses,
and validates returned data. Its account-view read uses the same strict projection as the
Electron list response; the separate account-summary read remains a smaller CLI contract.
The account token, key material, proxy credentials and raw database fields never enter
either RPC response. Remote account operations propagate failures without an embedded persistence
fallback. Proxy replacement/removal is a bounded write-only core RPC operation; no RPC reads
the stored proxy URL. The repository logs only the account ID and configured/removed state,
and replaces database write failures with a value-free error so proxy credentials cannot
appear in normal logs or transport errors. Shutdown closes RPC admission before draining
requests and stopping persistence.

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

Cloud identity-profile account operations use strict account, revision and profile schemas at
the renderer and private core RPC boundaries. The selected account owner reads and writes bindings,
baseline and history. The user-visible profile fields are returned for explicit profile management;
account tokens, storage paths, SQLite diagnostics and stacks are not part of that result. Failures
cross the boundaries only as stable profile categories. Mutations join the core account-work drain.
Opening the storage folder remains in Electron main and returns no path to React.

The renderer reads account security status from the selected persistence owner, so remote mode
reports the standalone core's key-storage state. The account owner resolves validation links
from stored health data and returns only a bounded, normalized `https://accounts.google.com`
URL over the private core RPC. Electron main validates the returned URL again before invoking
the system browser. The renderer receives no URL; failures expose only stable categories and
never include stored URLs, account tokens or internal diagnostics.

OAuth client discovery and active-client preference use strict public descriptors containing
only the key, label, client ID and active/builtin flags. Client secrets and registry internals
remain inside the owning process. Both renderer and core RPC validate bounded client keys;
unknown keys produce a value-free error, and malformed environment entries or invalid saved
preferences are logged without their raw values. Preference changes persist through the
existing `active_oauth_client_key` setting. Electron currently selects embedded account ownership.

The Electron cloud-account list and account-returning mutations project a strict renderer view
before the MessagePort response. The view includes display metadata, UI quota fields, active flags and
bounded health signals, but excludes tokens, device profiles, raw provider status reasons,
verification links, proxy URLs and gateway-only quota policy fields. The card displays only whether a proxy is configured;
replacing or removing it uses the existing account-scoped mutation. Account export and identity
profile operations remain separate, explicitly invoked capabilities with their own contracts.

## Logging and errors

Logging may include operation names, provider names, status codes, sanitized identifiers and bounded diagnostic metadata. It must not include raw authorization values, credential payloads, request bodies containing secrets, or unbounded external responses.

Errors sent through IPC or HTTP must expose information needed by the caller while keeping internal stack traces, secrets and provider-sensitive payloads out of normal user-facing fields. Internal diagnostics may retain a sanitized stack in trusted logs when existing logging policy permits it.

When adding a new sensitive field, update the central masking behavior and its tests before logging objects that may contain that field.

## Persistence

- Use prepared statements or Drizzle query construction for variable data.
- Validate rows and serialized payloads when reading them from storage.
- On-disk format changes require an explicit version, migration or rejection policy.
- Backup and restore paths must preserve transactional safety and must not silently produce partially restored state.
- Credential migration must fail clearly when every usable credential source fails; it must not erase the last recoverable value before replacement succeeds.

Database schema, durable payload and credential-location changes require an Agent Note because they impose compatibility and recovery obligations.

### Proxy traffic and thought persistence

Selected-owner audit management responses are validated and bounded below the ordinary control
response cap. Escaped body pages retain only complete chunks and continue from the first deferred
chunk. Owner admission/drain covers reads and mutations; transport failures never invoke local
fallbacks. Presentation journals retain at most 128 reference events and return at most 32 per
batch, without bodies or worker errors. Public audit IPC failures omit raw input, causes and
stacks. Repair retains the existing intentional backup-location result; this does not authorize
reading that backup through control RPC.

Explicit Thought/cURL content uses purpose- and resource-bound owner capabilities with epoch,
UUID, expiry and sequential byte cursors. Each content owner permits four snapshots and 256 MiB
of retained body buffers. Each chunk is at most 64 KiB before base64 encoding; normal control
limits remain unchanged. Completion, explicit close, expiry and owner drain release retention.
Disconnect cleanup is best-effort and diagnosed without values; expiry bounds orphan retention.
Thought detail intentionally returns plaintext thought, visible text and nullable signature to
the requesting renderer. Their combined body has a 256 MiB operational transfer ceiling while
thought text retains its 64 MiB limit. cURL capabilities and commands stay in Electron main;
only copied status reaches React. The 8 MiB replay-body limit remains separate from the 64 MiB
quoted-command ceiling. Current gateway key inclusion remains opt-in; upstream credentials
remain prohibited. Public Thought/cURL errors omit raw inputs, contents, causes and stacks.

Traffic audit and Thought Store data live in separate SQLite databases under the proxy state
directory and are written by separate bounded worker threads. The model path is fail-open: queue
overflow, worker failure and shutdown-drain timeout are reported as counters but do not alter the
provider response. Read-only audit/Thought management calls are not recursively audited. Clear,
delete, repair and setting changes produce metadata-only admin events.

Before an audit payload reaches SQLite, authorization and cookie headers, credential-bearing query
parameters, and recursively matched JSON credential keys are replaced with `[REDACTED]`. Media
bodies retain metadata and a SHA-256 digest, not bytes. Free-form prompt, code and tool output is
not heuristically scanned; users who place credentials in ordinary content are choosing to retain
that content in plaintext. Thought text and signatures are also plaintext by explicit product
policy. The UI automatically previews stored bodies up to 20 KiB. Larger bodies show a 20 KiB
prefix until the user chooses to browse more; signatures remain collapsed until expanded.

The Traffic Monitor's cURL export is an explicit local clipboard exception, not an audit-storage
exception. Its credential switch starts off for each page visit and resets on filter changes. When selected, the main process
substitutes the **current** local proxy API key into a parent-request command and writes it directly
to the OS clipboard; the renderer and IPC response never receive the key. Historical credentials
cannot be reconstructed from redacted records. Upstream-attempt export is always redacted. The
clipboard may be read by other local applications and the pasted command may disclose its key;
users should treat it as a secret and clear it when finished. Export refuses partial, expired,
binary or oversized request bodies rather than silently generating an incomplete replay.

Audit parent and attempt tables contain metadata and references, never large inline body columns.
Sanitized body content is written in 64 KiB chunks with a 100 MiB stored-prefix ceiling per unique
logical payload. Exact payloads may share a reference only inside the same parent request; there is
no cross-request content-addressed ownership or reference-count lifecycle. Normal SSE stores a
reconstructed response and preserves unrecognized events. Parse failures store redacted raw SSE,
framing and error location, not byte-identical upstream content. Authenticated body reads are paged
by default; the full-content route streams chunks and the renderer requires explicit confirmation
before accumulating a complete body for clipboard copy.

Both databases reject unknown future schema versions. Corruption does not trigger automatic
replacement. An authenticated explicit repair first closes the worker, then preserves the main
database and WAL/SHM sidecars under a timestamped `.corrupt-*` name before creating a fresh file.
For this unshipped audit feature, an older audit schema is archived with its WAL/SHM sidecars and
replaced by an empty schema v4 database. No old audit rows are migrated; the independent Thought
Store database is untouched.

### Linux Secret Service collections

When `secret-tool` is available on Linux, credential writes synchronize the same payload to the `login` collection and then the default collection. The default collection remains the application compatibility gate: a default-write failure falls back to the native keyring even when the `login` write succeeded. Both writes are bounded to ten seconds and diagnostics contain collection outcomes only, never credential payloads or raw process errors.

Windows Classic credential storage uses the official target `gemini:antigravity` through the existing Koffi dependency and Win32 `CredReadW`/`CredWriteW`. DLLs are loaded from the absolute Windows system directory. Reads do not create or mutate an entry; missing entries are distinguished from native failures. Returned metadata and payload size are validated before decoding, native read allocations are freed, and temporary write buffers are cleared. The payload remains raw UTF-8 JSON. The native integration fixture uses an isolated target, checks it through independent credential enumeration, and deletes only that synthetic target.

Linux native fallback reads and writes use the default `Entry` builder for service `gemini` and username `antigravity`. The Windows target `gemini:antigravity` is not passed to Secret Service, where an explicit target names a collection and can trigger a creation prompt. Native calls remain synchronous and do not inherit the `secret-tool` deadline; locked or unavailable keyrings remain explicit failures.

Explicit Linux Classic switches also atomically replace the official standalone cache at `~/.gemini/jetski-standalone-oauth-token` with the same payload. The official Linux language server can select this file instead of Secret Service. This application-owned credential cache is an explicit plaintext-file exception: its directory is created with mode `0700` and its file with mode `0600`, using the existing private-file writer. Failure to write the required file fails the switch rather than accepting only the keyring update. CLI switches do not update this Classic cache, and Windows and macOS retain their existing credential-store behavior.

## Proxy and external services

### Google OAuth scopes

Google authorization URLs request `openid` alongside the existing service scopes in the [shared scope definition](../src/shared/auth/googleOAuthScopes.ts). Explicit Agy switches write the same configured scope string to the generic Gemini OAuth cache; Classic and IDE switches do not synchronize that cache. The prepared account writer requires epoch seconds and omits empty optional ID/project values. At the standalone Google cache API boundary, expiry values greater than `10_000_000_000` are treated as milliseconds and written unchanged; other values are converted from seconds to milliseconds. The internal switch contract remains seconds.

### Local snapshots and client recovery files

New Manager account snapshots encrypt the entire version `1.0` envelope with the existing master key before atomic file replacement. Historical plaintext JSON remains readable and is not rewritten automatically. Encrypted snapshots require the original Manager master key; moving the JSON file alone to another installation does not transfer the account. Decryption failure stops snapshot restore before application shutdown. Keep the original files and Manager keyring available for recovery; rollback to a reader that only understands JSON requires a decrypted snapshot through the current reader or a fresh account capture. Never log decrypted content.

Official-client SQLite state, its online recovery backup and required CLI/standalone OAuth caches are interoperability exceptions to Manager's encrypted-storage policy. They contain client-readable tokens, use private file permissions where supported, and must not enter logs, exports or source control. The SQLite recovery file preserves the state before the first write of an operation, including WAL data; it is not updated with replacement credentials. Recovery is manual with the client stopped and must preserve the database/WAL consistency. Native keyring updates and multiple client files are not one transaction: a later required-file or readback failure reports partial completion instead of success.

The cache scope string describes configured requests, not verified grants for an individual token. Adding a scope does not upgrade existing access or refresh tokens. Accounts missing the grant require a new authorization flow and user consent; refreshing or rewriting the cache alone is not a scope migration. Existing account records and credential files are not rewritten automatically when the application updates.

### External request boundaries

- Treat upstream responses and error payloads as untrusted input.
- Bound retained or emitted bodies, metadata, item counts and timeouts at the point where the complete value is known.
- Do not forward internal credentials or administrative details to downstream clients.
- Enforce authentication and authorization in the operation that performs the protected action, not only in UI visibility or prompt/schema filtering.
- Preserve protocol error semantics without returning raw provider secrets or internal implementation objects.

OpenAI Chat Completions local `video_url` paths are disabled by default. The user can enable
`proxy.experimental.allow_local_video_paths` in Settings; the running gateway reads this setting
for every request, so no restart is required. Once enabled, the existing proxy API-key boundary is
the only caller restriction and there is no directory allowlist: any authorized proxy client can
request any regular file readable by the desktop process. The Settings description must keep this
scope explicit. While the setting is disabled, `video_url` handling must not probe or read the local
filesystem; explicit local path forms are rejected lexically and ambiguous non-URL strings retain
the gateway's raw-Base64 fallback.

## Updates and external execution

### Coding tool configuration files

Claude Code and Codex settings store the existing gateway API key in the client-readable format
required by each client. Their first `.antigravity-manager.bak` recovery file preserves the exact
original text and may contain credentials from a previous provider. These are explicit local
interoperability files, not Manager account-database migrations. Files use mode `0600` where
supported; Windows access follows the containing profile's ACL. Do not share, log or commit
these files. Backups and arbitrary client settings never cross the control transport; previews
project only model/address fields and a hidden credential marker. The user confirms complete
restore in the UI or supplies CLI `--yes`. See
[coding-tool-configuration.md](coding-tool-configuration.md) for the difference between removal
and restoration.

Installer, updater, shell, subprocess and binary-patching changes are high risk. Validate exact targets and arguments, preserve platform quoting rules, and avoid command construction from untrusted strings. Update sources and artifacts must retain the repository's existing integrity and signing expectations.

Windows automatic updates use separate Squirrel and NSIS feeds. Only a recognized installed
package activates its matching updater; MSI and unpacked builds cannot invoke either automatic
installer. The release feed generator verifies the NSIS installer's size and SHA-512 against its
metadata before publishing a feed that points to the release asset. The updater does not disable
the library's installer verification. A local-feed override is used only when the explicit
unmanaged-test flag is also set; ordinary installed builds use the configured release feed.

## Required evidence

Standalone runtime preparation downloads Node only from the official distribution and verifies
the selected asset against its official SHA-256 list. Native rebuilds run in an isolated tree;
they never replace the Electron ABI dependencies. Generated runtime replacement checks its owned
manifest and resolved directory before moving or deleting anything. Failed restoration preserves
the previous tree for explicit recovery.

Dependency tracing scopes filesystem reads to the staging root, rejects cross-drive host paths
and external link targets, and requires the target native binaries before materialization.
Optional import warnings are reviewed explicitly; unknown warnings fail preparation.

Installed-resource credential acceptance uses unique synthetic service names in the real OS store.
Its test preload remaps both keytar and OpenCode's native keyring service, so production grants and
API keys are neither read nor changed. Windows native credential writes require a usable interactive
login session; a restricted execution token can load the native binary but fail OS-store operations.

Use [testing.md](testing.md) to select focused tests. Security-sensitive changes normally require:

- the owning behavior test;
- a test demonstrating rejection or sanitization at the actual runtime boundary;
- `npm run type-check` when a public or cross-process type changes;
- platform-specific evidence when behavior depends on the OS keyring, native modules, Electron packaging or installers.

If platform evidence cannot run locally, report it as unverified rather than replacing it with a mock-only claim.

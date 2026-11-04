# Client Credential and Recovery Security

This reference owns official-client credential destinations, local snapshots and recovery. Use [account switching acceptance](account-switch-acceptance.md) for live evidence and [global security rules](../../security.md) for shared requirements.

## Local-account transport

Legacy local-account transport contains bounded account/identity metadata and closed error categories, without backup paths, raw database rows or credential-bearing backup objects. Snapshot restore accepts an account ID and reads its existing backup only inside the selected owner. The unused raw backup/restore renderer contracts are removed; internal durable backup codecs and native injection policy remain unchanged. Admission/drain covers both reads and serialized writes, and existing database primitives close their per-operation handles in `finally` blocks.

## macOS credential and SQLite chain

On macOS, official-client credential reads and writes invoke `security` through PATH with
the `gemini` service and `antigravity` account. Installation attempts deletion first, then
creation with the complete `go-keyring-base64:` value after `-w` and `-A` last. The encoded
payload contains a nested token and optional root-level ID token. There is no update-in-place,
existence probe or subprocess deadline. The value is briefly visible to processes permitted
to inspect command arguments. Command failures discard the original subprocess error and
sanitize native stderr; credential values are never logged. `-A` permits application access
without a per-application access list. Deletion followed by failed creation can remove the
previous item; this installation path is an explicit exception to migration preservation below.

Classic and Agy creation mirrors the CLI token, flat OAuth token and active Google account files
under `.gemini`. Writes are direct; POSIX permission changes to `0600` are best effort.
CLI mirror failure is nonfatal, OAuth mirror failure stops the remaining mirror writes, and
the account file replaces its old-account list with an empty list. Classic installation has
no readback gate. Agy verifies only the system item's refresh token, with no file fallback
for confirmation. Ordinary reads can fall back to CLI then OAuth files on a failed Keychain
lookup; malformed successful output and process execution errors do not fall back.

Classic, Agy and pre-2.6 Mac IDE SQLite injection uses the shared `ItemTable` Drizzle schema, a best-effort
`.backup` copy and sequential upserts and deletions,
without transaction rollback or full-field readback. Native installation failure can fall
back to an existing client database and remain nonfatal even if that injection fails.
Identity-profile updates and optional service-machine-ID writes are also best effort.
Official-client identity and AI request acceptance must therefore be checked independently
of the Manager's success notification. See the
[macOS credential decision](../../../.agents/notes/implemented/security/2026-10-14-macos-client-credential-chain.md).

## Target isolation

Classic credential-store switches update the host system credential and, on Linux, the required Classic cache. Ordinary Windows and Linux IDE switches on version 2.6 or newer synchronize the captured profile's SQLite UnifiedStateSync desktop identity, the operating system's `gemini` / `antigravity` credentials and `~/.gemini/jetski-standalone-oauth-token`. The desktop and embedded Agent have separate authentication readers; profile SQLite alone does not establish Agent identity. Unknown IDE versions, older IDEs and macOS retain their existing destination.

The runtime closes the captured IDE tree before required writes, verifies each destination and restarts the same installation/profile. It then checks the official Agent's `GetAuthStatus` and `GetUserStatus` through a loopback hub belonging to the newly launched main process. Every observed hub must report valid authentication and the selected email. Observation has one 30-second deadline; missing hubs, changed process identities, unsupported responses, and mismatches cannot finalize the Manager account. No generation request is made during this check. Responses and CSRF values remain inside the runtime.

Workspace provisioning explicitly selects the existing workspace writer behavior: this ordinary-switch change does not add SQLite/cache synchronization or identity confirmation to workspace launch. Windows IDE 2.6 workspace credentials still use the shared Windows item. Separate profiles and HOME directories do not isolate it; concurrent account isolation remains unresolved. The standalone fallback added here belongs to the current ordinary-switch OS environment, not to managed workspace homes. No accepted-terms records are manufactured.

Explicit Agy switches update the current operating-system environment's local CLI session and generic Google OAuth files without writing the host system credential or sessions in WSL distributions. The local CLI session is written and read back before the switch can succeed.

### Mac IDE 2.6 ordinary account switches

The IDE adapter synchronizes desktop SQLite, the `gemini`/`antigravity` Keychain item and
`.gemini/jetski-standalone-oauth-token`.
The Keychain value uses `go-keyring-base64:`, a nested token with `expires_in: 3599`, root-level
`auth_method`, `id_token_email` and optional `id_token`. The existing `security` delete/create,
`-w` and `-A` transport is reused. No update-in-place, hexadecimal argument transport or new
Mac Keychain recovery mechanism is introduced.

The standalone file contains the same JSON payload. `oauth_creds.json` and `google_accounts.json`
use the OAuth cache format, including an empty `old` account list. The dedicated
`antigravity-cli/antigravity-oauth-token` session is left untouched by an IDE switch. Standalone
replacement uses the existing private atomic writer; Google mirrors retain direct writes and
best-effort `0600` permissions. Keychain and file-mirror failures warn and continue.

The shared SQLite writer provides a WAL-aware `.account-switch.backup` and transactional injection.
An injection failure stops later writes. After one full restart, the freshly launched IDE's own
`agy` hubs must confirm valid authentication and the selected email before account finalization.
Mirror warnings alone therefore cannot finalize a mismatched or unavailable Agent account.
Workspace provisioning keeps its previous SQLite-only route.

Mac IDE account reads return the complete nested access/refresh/expiry fields and root ID token,
so local snapshots and current-account display retain their required input. On failed Keychain
lookup, the search order is CLI token, standalone token, then flat OAuth. A separately selected CLI
session can therefore take precedence over the IDE standalone cache during fallback; the normal
successful Keychain lookup remains primary. Classic/Agy retain their refresh-token-only reader.

Native and file changes can partially succeed and are not automatically rolled back. The Mac
transport can remove the old item before a failed creation; the SQLite backup does not restore
Keychain access policy or credential files. Official-client sign-in is the recovery path when
native credentials are lost. Windows/Linux native recovery APIs do not apply to Mac.

## Windows Classic credential storage

Windows Classic credential storage uses the official target `gemini:antigravity` through the existing Koffi dependency and Win32 `CredReadW`/`CredWriteW`. DLLs are loaded from the absolute Windows system directory. Reads do not create or mutate an entry; missing entries are distinguished from native failures. Returned metadata and payload size are validated before decoding, native read allocations are freed, and temporary write buffers are cleared. The payload remains raw UTF-8 JSON. The native integration fixture uses an isolated target, checks it through independent credential enumeration, and deletes only that synthetic target.

Windows IDE 2.6 ordinary switches reuse that native target. Recovery snapshots preserve exact payload bytes and writable metadata; entries with native attributes are rejected before mutation because their recovery is unsupported. The plaintext JSON sibling `state.vscdb.account-switch.credentials.backup` holds the pre-write native item and standalone file, including absence. It requires no Manager key. Capture occurs after shutdown, once per prepared operation, and backup write/readback must succeed before client state changes. It is replaced on the next switch; retain it with its corresponding SQLite `.account-switch.backup` for manual recovery. Historical encrypted records remain readable with their original key.

`restoreWindowsIdeCredentials` is a trusted runtime recovery API, not renderer IPC. It holds the runtime's switch guard, refuses running official IDE/App clients, reads and validates the selected profile's backup, rejects redirected standalone paths, restores native credentials with full readback, and restores or removes the standalone file with byte readback. It does not restore SQLite or start the client. A separate maintenance process must first stop the Manager/Core owner as well; the switch guard is process-local. Keep clients stopped while separately restoring the matching SQLite backup, without mixing in a later WAL. Restoration across these stores is not atomic; a failed restore remains an error and preserves the recovery files. Moving a native recovery record to another HOME is rejected. Native recovery records restore the original environment; use account snapshots for account migration. Code rollback alone does not restore accounts.

## Linux Secret Service collections

When `secret-tool` is available on Linux, credential writes synchronize the same payload to the `login` collection and then the default collection. The default collection remains the application compatibility gate: a default-write failure falls back to the native keyring even when the `login` write succeeded. Both writes are bounded to ten seconds and diagnostics contain collection outcomes only, never credential payloads or raw process errors.

Linux native fallback reads and writes use the default `Entry` builder for service `gemini` and username `antigravity`. The Windows target `gemini:antigravity` is not passed to Secret Service, where an explicit target names a collection and can trigger a creation prompt. Native calls remain synchronous and do not inherit the `secret-tool` deadline; locked or unavailable keyrings remain explicit failures.

Explicit Linux Classic switches also atomically replace the official standalone cache at `~/.gemini/jetski-standalone-oauth-token` with the same payload. The official Linux language server can select this file instead of Secret Service. This application-owned credential cache is an explicit plaintext-file exception: its directory is created with mode `0700` and its file with mode `0600`, using the existing private-file writer. Failure to write the required file fails the switch rather than accepting only the keyring update. CLI switches do not update this Classic cache, and Windows and macOS retain their existing credential-store behavior.

## Linux IDE 2.6 recovery

Linux IDE switching uses the existing Koffi dependency with system libsecret to enumerate every
Secret Service item matching service `gemini` and username `antigravity`. Existing items in all
collections receive the same payload without changing their labels, attributes or collection.
An empty search creates one item in the default collection. Every item's bytes must read back
before the required standalone-file write. Snapshot reads reject divergent refresh-token owners;
access-token refresh in one collection is allowed and the latest expiry is selected.

Native calls use asynchronous Koffi dispatch with one ten-second GCancellable per operation.
Locked/unreadable items fail preflight; the adapter does not request an unlock during search.
GLib libraries remain loaded because their registered types have process lifetime. Native object,
list, table, error and secret-value references are released by their operation owner.

The plaintext JSON sibling `state.vscdb.account-switch.linux-credentials.backup` preserves each original
item's object path, exact secret bytes/content type, and standalone bytes/mode or absence. Capture
occurs after client shutdown and before writes. New records do not require a Manager key;
historical encrypted records can still be read with their original key.
`restoreLinuxIdeCredentials` holds the switch guard and requires every official desktop client to
be stopped. It restores original item secrets in place, removes newly created matching items, and
verifies complete snapshot equality before restoring the standalone file. If an original item was
removed or its provider object path changed, recovery refuses before native mutation; it does not
guess a destination collection. SQLite restoration remains a separate stopped-client operation.
Stop the Manager/Core owner before running a separate recovery process. Cross-store recovery is
manual and non-atomic; a failure remains an error and retains the protected backups.

Linux workspace provisioning retains its existing SQLite route. Ordinary IDE switching updates
shared Secret Service credentials and does not provide simultaneous workspace account isolation.

## Google OAuth scopes

Google authorization URLs request `openid` alongside the existing service scopes in the [shared scope definition](../../../src/shared/auth/googleOAuthScopes.ts). Explicit Agy switches write the same configured scope string to the generic Gemini OAuth cache. Windows/Linux Classic and IDE switches do not synchronize that cache; Mac follows the credential chain described above. The prepared account writer requires epoch seconds and omits empty optional ID/project values. At the standalone Google cache API boundary, expiry values greater than `10_000_000_000` are treated as milliseconds and written unchanged; other values are converted from seconds to milliseconds. The internal switch contract remains seconds.

## Local snapshots and client recovery files

New Manager account snapshots store the existing version `1.0` envelope as plaintext JSON using atomic replacement and private file permissions. A snapshot can be copied to another machine without transferring the Manager master key. Capturing, reading and discovering plaintext snapshots never initializes encryption or queries the keyring. Loading the local account list attempts migration of every registered encrypted snapshot; selecting a snapshot also migrates it after successful decryption and schema validation. The original decoded JSON is atomically installed with all fields preserved. A byte comparison immediately before replacement refuses a newer capture, and a deleted snapshot is not recreated. Plaintext snapshots remain untouched.

List-time migration is serialized with capture, switching and deletion through the local-account owner. A failed file is retained and logged by sanitized account ID; the list remains available and other files continue migrating. Result logs distinguish migrated and failed counts. Selecting an unreadable or unwritable snapshot fails before client shutdown. Run the updated Manager and load the local account list on the original machine while its key is available before copying old account files elsewhere. Discovery of external account sources stays read-only. If the original key is unavailable, retain the old ciphertext and recapture or sign in again. Never log snapshot contents.

Before replacing a valid encrypted snapshot, migration preserves both exact representations in
`<snapshot>.migration-backups/<sha256-of-original-ciphertext>/encrypted.snapshot` and `decrypted.json`.
Each file is written atomically and compared with its expected bytes. Both confirmations are required
before the active snapshot is replaced. Existing backup files must match and are never overwritten;
a different original ciphertext creates a separate version directory. New directories use `0700`
and new files use `0600` where supported. Redirected backup directories and files are rejected.
An incomplete backup attempt leaves the current snapshot intact; completed backup files remain for
retry or recovery. A failed final replacement retains both backups and the original ciphertext.

Migration history is not automatically pruned and account deletion does not delete it. To recover,
stop the Manager/Core owner, preserve the current snapshot, then copy a selected `decrypted.json`
back to the snapshot path recorded in the account index. The JSON copy needs no original key.
Alternatively, copy `encrypted.snapshot` there while its original key is available; a subsequent
read migrates that working copy and verifies the retained pair. Keep the history files themselves
unchanged. Backup copies reside beside the active snapshot and do not protect against loss of the
entire profile or storage device.

Account snapshots, native recovery JSON, official-client SQLite state, its online recovery backup and required CLI/standalone OAuth caches contain readable tokens. Protect these files and their backups with OS account permissions; never attach them to diagnostics or source control. Intentional account migration transfers account snapshots, while native recovery records retain environment checks and do not serve as portable account exports. The SQLite recovery file preserves the state before the first write of an operation, including WAL data; it is not updated with replacement credentials. Recovery is manual with the client stopped and must preserve the database/WAL consistency. Multiple files within one selected client target are not one transaction: a later required-file or readback failure reports partial completion instead of success without writing another client's credential store.

The cache scope string describes configured requests, not verified grants for an individual token. Adding a scope does not upgrade existing access or refresh tokens. Accounts missing the grant require a new authorization flow and user consent; refreshing or rewriting the cache alone is not a scope migration. Existing account records and credential files are not rewritten automatically when the application updates.

## Classic terms state

Windows Classic retention reads the official app_storage.json only in the captured profile.
It observes the last accepted username and string standard/GCP flag, without accepting terms or
synthesizing an account's first acceptance. Its Manager-owned history lives under
.antigravity-agent/classic-terms/<profile-digest>.json, with format version 1 and at most 256
account digest/type pairs. It contains no plaintext email, token or provider response. Digests are
local pseudonymous identifiers, not encryption. Entries belong to the exact canonical profile,
executable identity and product/build version; changed revisions or malformed history require
manual confirmation again. Unavailable client version leaves retention disabled for that switch.
The first baseline cannot establish which earlier client version originally accepted an existing
record. Exact legal terms revisions are not exposed by this storage contract; the official
standard/GCP check remains authoritative and no version-independent consent is inferred.

Writes require a stopped captured client and merge only the two consent fields into validated,
bounded official JSON. The owner rechecks process state and file contents before replacement,
uses a synchronized sibling temporary file and verifies readback. Links and oversized files are
rejected. Unrelated settings are retained. History is saved before replacing a valid baseline;
invalidation clears stale official fields before committing the new revision, so failed writes
cannot silently import stale consent on retry. Prelaunch recovery restores only this invocation's
consent fields and refuses to overwrite later acceptance. These are local filesystem checks,
not a lock enforced by the official client; independently started external writers can still race.
No raw file contents, paths or identities enter the new diagnostic messages.

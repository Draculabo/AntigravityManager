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

Successful creation mirrors the CLI token, flat OAuth token and active Google account files
under `.gemini`. Writes are direct; POSIX permission changes to `0600` are best effort.
CLI mirror failure is nonfatal, OAuth mirror failure stops the remaining mirror writes, and
the account file replaces its old-account list with an empty list. Classic installation has
no readback gate. Agy verifies only the system item's refresh token, with no file fallback
for confirmation. Ordinary reads can fall back to CLI then OAuth files on a failed Keychain
lookup; malformed successful output and process execution errors do not fall back.

Mac client SQLite injection uses the shared `ItemTable` Drizzle schema, a best-effort
`.backup` copy and sequential upserts and deletions,
without transaction rollback or full-field readback. Native installation failure can fall
back to an existing client database and remain nonfatal even if that injection fails.
Identity-profile updates and optional service-machine-ID writes are also best effort.
Official-client identity and AI request acceptance must therefore be checked independently
of the Manager's success notification. See the
[macOS credential decision](../../../.agents/notes/implemented/security/2026-10-14-macos-client-credential-chain.md).

## Target isolation

Classic credential-store switches update the host system credential and, on Linux, the required Classic cache. Windows IDE versions before 2.6.0 use the selected SQLite profile; IDE 2.6.0 and later use the shared `gemini:antigravity` system credential because that version family authenticates from the OS credential store. An IDE 2.6+ switch therefore changes the credential seen by other Antigravity clients that use the same system target. When version detection fails, IDE switching retains the existing SQLite behavior. Explicit Agy switches update the current operating-system environment's local CLI session and generic Google OAuth files without writing the host system credential or sessions in WSL distributions. The local CLI session is written and read back before the switch can succeed.

## Windows Classic credential storage

Windows Classic credential storage uses the official target `gemini:antigravity` through the existing Koffi dependency and Win32 `CredReadW`/`CredWriteW`. DLLs are loaded from the absolute Windows system directory. Reads do not create or mutate an entry; missing entries are distinguished from native failures. Returned metadata and payload size are validated before decoding, native read allocations are freed, and temporary write buffers are cleared. The payload remains raw UTF-8 JSON. The native integration fixture uses an isolated target, checks it through independent credential enumeration, and deletes only that synthetic target.

## Linux Secret Service collections

When `secret-tool` is available on Linux, credential writes synchronize the same payload to the `login` collection and then the default collection. The default collection remains the application compatibility gate: a default-write failure falls back to the native keyring even when the `login` write succeeded. Both writes are bounded to ten seconds and diagnostics contain collection outcomes only, never credential payloads or raw process errors.

Linux native fallback reads and writes use the default `Entry` builder for service `gemini` and username `antigravity`. The Windows target `gemini:antigravity` is not passed to Secret Service, where an explicit target names a collection and can trigger a creation prompt. Native calls remain synchronous and do not inherit the `secret-tool` deadline; locked or unavailable keyrings remain explicit failures.

Explicit Linux Classic switches also atomically replace the official standalone cache at `~/.gemini/jetski-standalone-oauth-token` with the same payload. The official Linux language server can select this file instead of Secret Service. This application-owned credential cache is an explicit plaintext-file exception: its directory is created with mode `0700` and its file with mode `0600`, using the existing private-file writer. Failure to write the required file fails the switch rather than accepting only the keyring update. CLI switches do not update this Classic cache, and Windows and macOS retain their existing credential-store behavior.

## Google OAuth scopes

Google authorization URLs request `openid` alongside the existing service scopes in the [shared scope definition](../../../src/shared/auth/googleOAuthScopes.ts). Explicit Agy switches write the same configured scope string to the generic Gemini OAuth cache; Classic and IDE switches do not synchronize that cache. The prepared account writer requires epoch seconds and omits empty optional ID/project values. At the standalone Google cache API boundary, expiry values greater than `10_000_000_000` are treated as milliseconds and written unchanged; other values are converted from seconds to milliseconds. The internal switch contract remains seconds.

## Local snapshots and client recovery files

New Manager account snapshots encrypt the entire version `1.0` envelope with the existing master key before atomic file replacement. Historical plaintext JSON remains readable and is not rewritten automatically. Encrypted snapshots require the original Manager master key; moving the JSON file alone to another installation does not transfer the account. Decryption failure stops snapshot restore before application shutdown. Keep the original files and Manager keyring available for recovery; rollback to a reader that only understands JSON requires a decrypted snapshot through the current reader or a fresh account capture. Never log decrypted content.

Official-client SQLite state, its online recovery backup and required CLI/standalone OAuth caches are interoperability exceptions to Manager's encrypted-storage policy. They contain client-readable tokens, use private file permissions where supported, and must not enter logs, exports or source control. The SQLite recovery file preserves the state before the first write of an operation, including WAL data; it is not updated with replacement credentials. Recovery is manual with the client stopped and must preserve the database/WAL consistency. Multiple files within one selected client target are not one transaction: a later required-file or readback failure reports partial completion instead of success without writing another client's credential store.

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

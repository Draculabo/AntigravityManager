# Agent Note: Agy Google OAuth File Synchronization

Status: implemented

## Problem

Antigravity Manager already updates the operating-system credential store and the dedicated Agy CLI token file. Some Agy authentication paths also read `~/.gemini/oauth_creds.json` and select the account through `~/.gemini/google_accounts.json`. Leaving those files untouched can make an accepted Agy switch continue under the previous Google account. Writing them for every credential-store update would instead overwrite an unrelated Gemini CLI login.

## Decision

Only callers that explicitly switch the `agy` target request generic Google OAuth file synchronization. The writer uses the OAuth scopes owned by `GoogleAPIService`, converts the internal expiry from seconds to the millisecond `expiry_date` wire field, and includes `id_token` only when it is available.

Both files are serialized before any write. Each file is replaced through a mode-`0600` temporary file in the destination directory. `oauth_creds.json` is installed first and `google_accounts.json` is installed last as the active-account commit marker. The previous active email is retained in the deduplicated `old` list. A malformed existing account index aborts this optional synchronization before either file changes. File synchronization remains best-effort after the required system credential-store write, and logs contain no token or email values.

## Alternatives considered

- Synchronize the generic files on every credential-store write. Rejected because Classic and IDE switches must not take ownership of a separate Gemini CLI session.
- Reset `google_accounts.json.old` on every switch. Rejected because the official account manager retains previous identities and uses that history for later selection.
- Write files directly. Rejected because interruption can truncate a live credential file.
- Make file synchronization failure fail the whole account switch. Rejected because the system credential store is authoritative for the selected application and optional CLI compatibility must not roll back a successful switch.

## Consequences

An explicit Agy switch updates the system credential store, the dedicated Agy CLI token, and the generic Gemini OAuth cache. The generic cache remains plaintext by protocol design but is restricted to the current user with mode `0600` where the platform enforces POSIX permissions. A failure between the two atomic replacements can leave a new OAuth token with the old active marker; writing the marker last prevents advertising a new account before its token exists, but the pair is not a filesystem transaction.

## Verification

- `npm run test:unit -- --run src/tests/unit/google-oauth-credential-store.test.ts src/tests/unit/agy-cli-token-store.test.ts`
- `npm run test:unit -- --run src/tests/unit/antigravity-credential-store-write.test.ts`
- `npm run test:unit -- --run src/tests/unit/account.test.ts src/tests/unit/credential-store-injection-expiry.test.ts src/tests/unit/cloudHandler-sync.test.ts`
- `npm run type-check`
- `npm run check:agent-contracts`

Live platform evidence collected on 2026-08-30:

- Windows Credential Manager completed an isolated native write/read/delete round trip, and the temporary entry was removed.
- The Electron application completed cold startup through database initialization, ORPC startup, renderer load, and authenticated account refresh.
- Windows Agy `1.1.22` authenticated successfully and listed available models. A real generation request was rejected before token consumption because Gemini Code Assist is unavailable for the account's current location. The Windows generic OAuth and Agy token files remained absent.
- WSL Ubuntu had a D-Bus session and existing Gemini OAuth files with the expected top-level keys, but no `secret-tool` executable. Gemini CLI `0.17.1` loaded its cached credential and accepted the configured gcloud project, then rejected generation because the account does not have a valid product license (`#3501`).

Successful Agy/Gemini generation, native Linux secret-service persistence, and macOS Keychain persistence remain unverified because the authenticated accounts fail provider-side location or license eligibility, and the available hosts do not include native Linux secret-service tooling or macOS.

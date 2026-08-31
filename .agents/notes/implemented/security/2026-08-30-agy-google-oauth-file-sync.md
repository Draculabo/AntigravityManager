# Agent Note: Agy Google OAuth File Synchronization

Status: implemented

## Problem

Antigravity Manager already updates the operating-system credential store and the dedicated Agy CLI token file. Some Agy authentication paths also read `~/.gemini/oauth_creds.json` and select the account through `~/.gemini/google_accounts.json`. Leaving those files untouched can make an accepted Agy switch continue under the previous Google account. Writing them for every credential-store update would instead overwrite an unrelated Gemini CLI login.

## Decision

Only callers that explicitly switch the `agy` target request generic Google OAuth file synchronization. The writer uses the OAuth scopes owned by `GoogleAPIService`. The type remains `string | undefined`; no nullable or generated ID-token state is introduced. At the generic OAuth file boundary, it matches upstream's exact expiry rule: a value greater than `10_000_000_000` is already milliseconds and remains unchanged; every other value is multiplied by 1000 for the millisecond `expiry_date` wire field.

 Existing service scopes, including `aicode`, remain unchanged. The [security reference](../../../../docs/security.md#google-oauth-scopes) owns the current grant and reauthorization contract.

Both files are serialized before any write. Each file is replaced through a mode-`0600` temporary file in the destination directory. `oauth_creds.json` is installed first and `google_accounts.json` is installed last as the active-account commit marker. The previous active email is retained in the deduplicated `old` list. A malformed existing account index aborts this optional synchronization before either file changes. File synchronization remains best-effort after the required system credential-store write, and logs contain no token or email values.

## Alternatives considered

- Synchronize the generic files on every credential-store write. Rejected because Classic and IDE switches must not take ownership of a separate Gemini CLI session.
- Reset `google_accounts.json.old` on every switch. Rejected because the official account manager retains previous identities and uses that history for later selection.
- Write files directly. Rejected because interruption can truncate a live credential file.
- Make file synchronization failure fail the whole account switch. Rejected because the system credential store is authoritative for the selected application and optional CLI compatibility must not roll back a successful switch.

## Consequences

An explicit Agy switch updates the system credential store, the dedicated Agy CLI token, and the generic Gemini OAuth cache. The generic cache remains plaintext by protocol design but is restricted to the current user with mode `0600` where the platform enforces POSIX permissions. A failure between the two atomic replacements can leave a new OAuth token with the old active marker; writing the marker last prevents advertising a new account before its token exists, but the pair is not a filesystem transaction.

No credential-format migration, automatic reauthorization, or token replacement accompanies the `openid` addition. Cached scope metadata can differ from the actual grants of older or imported tokens. The expiry-unit guard applies only while writing the generic OAuth file; it does not change internal expiry comparisons or rewrite existing account and credential data. This change does not claim to resolve those pre-existing limitations or guarantee an ID token for every account.

## Verification

For the `openid` addition, authorization URL tests cover both the active and explicitly selected OAuth client, and the cache test checks the complete serialized payload. Before the production change, all three scope assertions failed specifically because `openid` was absent. After the change, the following focused run passed all 35 tests:

- `npm test -- src/tests/unit/google-oauth-authorization.test.ts src/tests/unit/google-oauth-credential-store.test.ts src/tests/unit/antigravity-credential-store-write.test.ts src/tests/unit/agy-cli-token-store.test.ts src/tests/unit/sensitive-data-masking.test.ts --maxWorkers=2`

The expiry-unit regression covers the exact `10_000_000_000` boundary and the first value above it. The ID-token regression separately covers an absent field and an explicitly empty string. Before the writer changes, the above-threshold expiry was multiplied again and the empty ID token was omitted; after the changes, the focused credential-store test passed all seven cases.

This addition has no new live authorization, provider-grant, ID-token, or CLI evidence. The platform results below belong to the original file-synchronization work and do not validate the added scope.

Original file-synchronization verification:

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

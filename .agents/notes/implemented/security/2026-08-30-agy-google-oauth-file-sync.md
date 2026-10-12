# Agent Note: Agy Google OAuth File Synchronization

Status: implemented

## Problem

Antigravity Manager updates the dedicated Agy CLI token file. Some Agy authentication paths also read `~/.gemini/oauth_creds.json` and select the account through `~/.gemini/google_accounts.json`. Leaving those files untouched can make an accepted Agy switch continue under the previous Google account. Writing them for every host credential-store update would instead overwrite an unrelated CLI login. Issue #337 showed that coupling the shared payload format to shared write behavior also overwrote WSL CLI sessions when a host account changed and overwrote the host credential during an explicit Agy switch.

## Decision

Only callers that explicitly switch the `agy` target write the dedicated CLI session and generic Google OAuth files. They reuse the desktop credential payload format without writing the operating-system credential store. Classic credential-store writes do not call the CLI writer or enumerate WSL paths. The writer uses the OAuth scopes owned by `GoogleAPIService`. The type remains `string | undefined`; no nullable or generated ID-token state is introduced. At the generic OAuth file boundary, it matches upstream's exact expiry rule: a value greater than `10_000_000_000` is already milliseconds and remains unchanged; every other value is multiplied by 1000 for the millisecond `expiry_date` wire field.

 Existing service scopes, including `aicode`, remain unchanged. The [security reference](../../../../docs/security.md#google-oauth-scopes) owns the current grant and reauthorization contract.

Both files are serialized before any write. Each file is replaced through a mode-`0600` temporary file in the destination directory. `oauth_creds.json` is installed first and `google_accounts.json` is installed last as the active-account commit marker. The previous active email is retained in the deduplicated `old` list. A malformed existing account index aborts this synchronization before either generic OAuth file changes. The current operating-system environment's local Agy session write is required and confirmed. The writer does not discover or update sessions in WSL distributions or other environments. Logs contain no token or email values.

## Alternatives considered

- Synchronize the generic files on every credential-store write. Rejected because Classic and IDE switches must not take ownership of a separate Gemini CLI session.
- Update the host system credential as part of an explicit Agy switch. Rejected because the CLI has an independent file-backed session and host/WSL workloads must retain separate accounts.
- Broadcast an explicit Agy switch to discovered WSL distributions. Rejected because each operating-system environment owns an independent CLI session and a switch in one client must not change another client.
- Reset `google_accounts.json.old` on every switch. Rejected because the official account manager retains previous identities and uses that history for later selection.
- Write files directly. Rejected because interruption can truncate a live credential file.
- Treat generic OAuth synchronization as optional after the CLI session write. Rejected because Agy can select those files and continue under the previous account while reporting a successful switch.

## Consequences

An explicit Agy switch updates the current environment's dedicated Agy CLI token and generic Gemini OAuth cache without changing the host system credential or any WSL token file. Host Classic and IDE switches do not update CLI sessions. The generic cache remains plaintext by protocol design but is restricted to the current user with mode `0600` where the platform enforces POSIX permissions. A failure between the two atomic replacements can leave a new OAuth token with the old active marker; writing the marker last prevents advertising a new account before its token exists, but the pair is not a filesystem transaction.

No credential-format migration, automatic reauthorization, or token replacement accompanies the `openid` addition. Cached scope metadata can differ from the actual grants of older or imported tokens. The expiry-unit guard applies only while writing the generic OAuth file; it does not change internal expiry comparisons or rewrite existing account and credential data. This change does not claim to resolve those pre-existing limitations or guarantee an ID token for every account.

## Verification

Issue #337 adds three red-capable regressions. Before the target-isolation change, a host credential write called the Agy writer once, an explicit Agy switch entered the host credential-store write/readback path, and the CLI writer broadcast the payload to discovered WSL sessions. After separating orchestration in the prepared account writer and restricting the CLI writer to the current environment, the focused credential suites verify both write directions, local CLI ownership and required CLI OAuth file failure propagation without changing host credentials.

`node scripts/test-client-account-write.integration.mjs` passed on native Windows under Electron. It used a unique synthetic Windows credential target for exact A-B-A writes and confirmed that two mocked Agy destination writes left the host credential unchanged. The test cleans up the synthetic target. It does not write a real WSL token or establish official-client account identity.

Live Issue #337 acceptance used the current standalone Node 24 runtime and two authorized accounts in the isolated Windows CLI profile. Agy and Classic each passed cloud and local-snapshot A-B-A switching, six checks per target. Every check confirmed token readback and Google identity; Classic confirmed the official client identity, while Agy completed a real provider task after every switch. The runner restored the original Windows credential and stopped its owner after each matrix. The default Ubuntu WSL Agy token remained absent, and the SHA-256 digests of its existing `oauth_creds.json` and `google_accounts.json` remained unchanged before and after both matrices.

A WSL-native Node 25 check loaded the production payload, Agy session and Google OAuth writers directly through `ts-node` and completed synthetic A-B-A writes with exact file readback in the isolated Linux CLI home. The Windows system credential digest was identical before and after. The temporary runner, generated credentials and incomplete Linux runtime stage were removed after verification. The first IDE acceptance attempt was blocked by existing IDE processes and rejected the first switch before any credential write.

The remaining Issue #337 acceptance completed on 2026-10-13. After the user saved and closed the existing IDE, Windows IDE passed all six cloud and local-snapshot A-B-A checks. Each check confirmed token readback, live Google identity and official signed-in state. The runner verified byte-for-byte restoration of the Windows credential captured at its startup and stopped its owner. The IDE itself refreshed some access tokens, so those comparisons allow access-token rotation while requiring the same refresh token and verified account identity.

WSL Ubuntu then passed all six Agy cloud and local-snapshot A-B-A checks with the current standalone Node 24.19.0 runtime. Every check completed a real official CLI provider task. The Linux runtime was built with the checked-in lockfile on ext4, and its manifest hashes matched the repository lockfile and generated core/CLI bundles. A short ext4 profile and an isolated D-Bus/Secret Service session were required: the NTFS mount rejected Unix socket creation with `ENOTSUP`, and snapshots require the native OS keyring. The isolated GNOME Keyring daemon was stopped and its temporary profile, account files and keyring were deleted after confirming core shutdown. No production storage fallback or socket guard was changed.

The Windows credential and all three default Windows CLI files had identical digests immediately before and after the WSL matrix. The default Ubuntu Agy token remained absent, and both default Ubuntu Google OAuth files also had identical digests. The Windows baseline for this comparison was captured after the user closed the IDE; the earlier baseline crossed that user action and therefore was not used to establish WSL isolation. Sanitized reports remain under `out/account-switch-acceptance/windows-ide-cli-issue337-report.json` and `out/account-switch-acceptance/linux-agy-cli-issue337-report.json`.

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

The original 2026-08-30 checks did not verify successful Agy/Gemini generation or native Linux secret-service persistence. The later Issue #337 checks above establish Agy generation and native Linux keyring-backed snapshots. Gemini CLI generation and macOS Keychain persistence remain outside that evidence.

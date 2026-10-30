# Account switching acceptance tutorial

This procedure checks real account switching through both Manager CLI and Electron. It uses authorized Google accounts and official Antigravity clients. It does not substitute mocked credential stores or provider responses.

## Prerequisites

- Prepare an isolated home with two authorized accounts in `.antigravity-agent/cloud_accounts.db`, valid configuration, and an account ID array in a private JSON file. Do not commit either file.
- When cloning a prepared home, start with an empty local-account index or copy its snapshots
  and rewrite every `backup_file` into the new home's `.antigravity-agent/backups`. Absolute
  destinations from the source profile are not isolated by copying the index. With
  `--local-snapshots`, the runner rejects inherited external destinations and links before
  loading the runtime or changing credentials. The check does not relocate or restore files.
- Configure the official `classic`, `ide`, and `agy` executable paths. Give each desktop client its own isolated `--user-data-dir` and debugging port: Windows 9341/9342; Linux 9441/9442.
- Use the current standalone runtime for CLI. For Electron, use a built application with matching renderer and main bundles. Its debugging port is Windows 9330 or Linux 9430.
- Native SQLite and keyring libraries must match the ABI of the report process. `--native-root` selects a separate compatible native module directory when Electron and Node use different ABIs.
- Linux requires a graphical session and unlocked Secret Service keyring. WSLg checks do not establish support for every Linux desktop distribution.
- Save work and close existing official clients before the test. Windows credential storage is shared between profiles: the runner captures the original credential, restores it in cleanup, and verifies restoration.
  Recovery preserves the exact-target bytes and writable metadata in memory, skips unchanged
  entries, and refuses unsupported native attributes before mutation. A failed owner stop or
  credential restoration makes the acceptance result fail.
- Complete official desktop first-run setup in each isolated profile, including its security and data-use notice, before unattended verification. Account snapshots may restore first-run state; a returned setup screen requires completion again and does not establish a successful login.
- Record any upstream proxy used by the isolated configuration and official client. Evidence collected with a proxy does not establish the same behavior without it.

## Run the matrix

1. Build the acceptance helpers using `pnpm run test:acceptance accounts prepare`. Use `--output <directory>` to keep a separate verification run's bundles, and supply that directory with `--helpers` when running the matrix.
2. Run the acceptance command with `--owner cli` or `--owner electron`, a prepared `--runtime-root`, `--profile-home`, `--accounts-file`, and `--output`.
3. Add `--local-snapshots` for cloud and local A-B-A switching. Add `--probe-cli` to require a real provider response from the official Antigravity CLI.
4. For Electron, provide `--electron-bin` and optionally `--electron-app`. The runner invokes the renderer's real preload MessagePort transport.
5. Repeat each owner on Windows and Linux. `--target classic|ide|agy` isolates failures without rerunning unrelated clients.
6. Add `--keep-client-running` to exercise desktop switches and snapshots without the runner closing the client first. The report records `clientWasRunning` and `mainProcessPreserved` using the main process PID, creation time and executable identity. The production switch may restart the selected client; this option does not assert seamless in-process switching. Correlate these observations with `Switch trace v1` outcomes and official identity/consent results.
7. Only after explicit authorization to accept the official first-run terms, add `--complete-client-setup` when an isolated profile requires setup. The runner leaves interaction-data collection unchecked. It opens the official Settings account panel when the main screen does not display the account.

## Interpret results

- `passed`: the selected client's stored credentials belong to the selected account, Google confirms the live identity, and the official client confirms login through its visible account or a fresh `signedIn` authentication transition. The report names the confirmation method. The CLI client must satisfy the provider check when `--probe-cli` is enabled.
- `partial`: desktop credentials and a window are verified, but neither the visible account nor a fresh official authentication transition confirms login, or the client still requires first-run terms acceptance. Onboarding, sign-in and terms screen indicators are recorded without capturing account text.
- `failed`: a required operation, identity check, renderer startup, or provider task fails. The report identifies its stage and safe error categories.

Desktop authentication waits up to 60 seconds after the renderer opens. Visible account text while the page still says it is authenticating or requires sign-in is insufficient. An initial `Accept and continue` screen also waits for account state to load; if it remains at the deadline, the result is partial even when account text or a fresh authentication transition is present. Classic also requires both official acceptance fields to be present in the configured isolated
profile's app_storage.json and the recorded account to match the selected account. The runner
waits for that durable record after the dialog disappears; a missing, unreadable or other-account
record remains partial. Reports retain only that state and standard/GCP terms type, never account
text. Historical authentication records are insufficient. The Electron fixture in `scripts/acceptance/accounts/client-ui.integration.mjs` checks these rules; it is not a live-provider acceptance result.

If account text is absent, verification waits for an account or Settings control to become available before opening the account panel once. An early loading screen without that control does not end the attempt. First-run preparation includes the official client's complete isolated home, not only its Chromium profile directory.

## Diagnose repeated Classic terms

The observed official Classic 2.23.0 client keeps one last accepted account and terms type, not a
per-account acceptance list. Switching to another account or changing the terms type can show the
official dialog again. Completing a different account does not confirm acceptance for the selected
account. On Windows Classic credential-store switches, the Manager retains previously observed
records per profile, account digest and installation revision. It captures the official record
before shutdown, rereads after confirmed exit, and merges only the two consent fields after
credential injection. Initial accounts without a record still require the official dialog.
A changed installation or invalid history clears the old consent fields and requires fresh
confirmation. The official client still checks its current standard/GCP terms type; a mismatch
must be accepted manually. No acceptance button is clicked by the retention implementation.

For a same-account restart failure, keep the isolated window open after manual acceptance until
clientTermsAcceptance.state is recorded, then restart the same profile without switching.
Compare that result with A-B-A switching. Check the configured profile before inspecting its file;
a disappearing dialog alone is insufficient because the official renderer saves asynchronously.
A partial result with other-account identifies a stale account record; not-recorded identifies
missing fields, and unreadable requires inspecting file access or an incomplete write privately.
The acceptance reader never changes the official file or accepts terms. The production switch
may restore only an observed record, as described above. For retention acceptance, manually
complete each account once in the same isolated profile, then run A-B-A-B through both CLI and
Electron owners and restart each selected account three times. Check the durable fields after
normal shutdown as well as the visible identity. Version-change and corrupted-history checks
use isolated fixtures, never a formal user's consent file.

Keep the official installation revision stable during retention acceptance. In the isolated
Classic profile, temporarily disable the official automatic-update check and restore its prior
setting after the client exits. A downloaded update can install on normal close while the runner
is waiting for manual consent. Preserve failed reports, inspect updater events and verify the
installed version before repeating the run; do not classify that interrupted run as passed.

An initial failed loopback HTTPS navigation can be retried once through the official renderer without changing certificate validation. If navigation recovers, the report records `rendererRecoveredFromInitialFailure`; all account identity checks still apply. Persistent navigation failure remains a failure.

By default, Linux desktop acceptance closes the official client before switching and collecting a snapshot. Running-client acceptance is explicit through `--keep-client-running`. Clients that erase their profile argument require verified Linux singleton ownership and an open profile lock file; same-executable descendants must belong to that owner. Missing evidence still rejects the operation. Restart preserves Chromium's single `--user-data-dir=value` argument, which the official standalone client requires.

Check `cleanup.originalCredentialRestored` on Windows and `cleanup.ownerStopped` for CLI. Keep raw application logs and profile directories private. Reports omit emails, tokens, and Google response bodies. A window or valid credential alone must not be reported as full desktop acceptance.

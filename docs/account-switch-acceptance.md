# Account switching acceptance tutorial

This procedure checks real account switching through both Manager CLI and Electron. It uses authorized Google accounts and official Antigravity clients. It does not substitute mocked credential stores or provider responses.

## Prerequisites

- Prepare an isolated home with two authorized accounts in `.antigravity-agent/cloud_accounts.db`, valid configuration, and an account ID array in a private JSON file. Do not commit either file.
- Configure the official `classic`, `ide`, and `agy` executable paths. Give each desktop client its own isolated `--user-data-dir` and debugging port: Windows 9341/9342; Linux 9441/9442.
- Use the current standalone runtime for CLI. For Electron, use a built application with matching renderer and main bundles. Its debugging port is Windows 9330 or Linux 9430.
- Native SQLite and keyring libraries must match the ABI of the report process. `--native-root` selects a separate compatible native module directory when Electron and Node use different ABIs.
- Linux requires a graphical session and unlocked Secret Service keyring. WSLg checks do not establish support for every Linux desktop distribution.
- Save work and close existing official clients before the test. Windows credential storage is shared between profiles: the runner captures the original credential, restores it in cleanup, and verifies restoration.
- Complete official desktop first-run setup in each isolated profile, including its security and data-use notice, before unattended verification. Account snapshots may restore first-run state; a returned setup screen requires completion again and does not establish a successful login.
- Record any upstream proxy used by the isolated configuration and official client. Evidence collected with a proxy does not establish the same behavior without it.

## Run the matrix

1. Build the acceptance helpers using `npm run test:acceptance -- accounts prepare`.
2. Run the acceptance command with `--owner cli` or `--owner electron`, a prepared `--runtime-root`, `--profile-home`, `--accounts-file`, and `--output`.
3. Add `--local-snapshots` for cloud and local A-B-A switching. Add `--probe-cli` to require a real provider response from the official Antigravity CLI.
4. For Electron, provide `--electron-bin` and optionally `--electron-app`. The runner invokes the renderer's real preload MessagePort transport.
5. Repeat each owner on Windows and Linux. `--target classic|ide|agy` isolates failures without rerunning unrelated clients.
6. Add `--keep-client-running` to exercise desktop switches and snapshots without the runner closing the client first. The production switch may restart the selected client; this option does not assert seamless in-process switching.
7. Only after explicit authorization to accept the official first-run terms, add `--complete-client-setup` when an isolated profile requires setup. The runner leaves interaction-data collection unchecked. It opens the official Settings account panel when the main screen does not display the account.

## Interpret results

- `passed`: the selected client's stored credentials belong to the selected account, Google confirms the live identity, and the official client confirms login through its visible account or a fresh `signedIn` authentication transition. The report names the confirmation method. The CLI client must satisfy the provider check when `--probe-cli` is enabled.
- `partial`: desktop credentials and a window are verified, but neither the visible account nor a fresh official authentication transition confirms login. Onboarding and sign-in screen indicators are recorded without capturing account text.
- `failed`: a required operation, identity check, renderer startup, or provider task fails. The report identifies its stage and safe error categories.

Desktop authentication waits up to 60 seconds after the renderer opens. Visible account text while the page still says it is authenticating or requires sign-in is insufficient. Historical authentication records are insufficient. The Electron fixture in `scripts/acceptance/accounts/client-ui.integration.mjs` checks this rule; it is not a live-provider acceptance result.

An initial failed loopback HTTPS navigation can be retried once through the official renderer without changing certificate validation. If navigation recovers, the report records `rendererRecoveredFromInitialFailure`; all account identity checks still apply. Persistent navigation failure remains a failure.

By default, Linux desktop acceptance closes the official client before switching and collecting a snapshot. Running-client acceptance is explicit through `--keep-client-running`. Clients that erase their profile argument require verified Linux singleton ownership and an open profile lock file; same-executable descendants must belong to that owner. Missing evidence still rejects the operation. Restart preserves Chromium's single `--user-data-dir=value` argument, which the official standalone client requires.

Check `cleanup.originalCredentialRestored` on Windows and `cleanup.ownerStopped` for CLI. Keep raw application logs and profile directories private. Reports omit emails, tokens, and Google response bodies. A window or valid credential alone must not be reported as full desktop acceptance.

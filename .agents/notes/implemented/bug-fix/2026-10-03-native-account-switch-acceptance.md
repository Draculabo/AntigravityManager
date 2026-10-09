# Agent Note: Native account-switch acceptance corrections

Status: implemented

## Problem

Live Windows switching exhausted the AI-service exit budget while launching taskkill for individual services. A full taskkill tree could also return exit status 128 after the main process had already exited. Windows credential readback exposed a separate destructive-read defect: with @napi-rs/keyring 1.3.0, constructing a second Entry.withTarget for a written synthetic credential reset its stored blob to zero bytes. Mocked entry tests did not exercise that native constructor behavior.

## Decision

Terminate only verified dedicated AI service PIDs through Node's native process API. The native Windows whole-application transport is superseded by [hidden-window normal close](2026-10-09-windows-hidden-client-close.md); the captured-PID re-observation and deadline policy still applies. After a close-request error, proceed only if the captured PID has disappeared; do not issue another termination command. Keep WSL Windows command-error behavior unchanged.

Use the existing Koffi dependency with Win32 CredReadW and CredWriteW for the exact generic credential target gemini:antigravity. Keytar joins service/account with a slash, so its successful write and readback do not establish compatibility with the official client. Local vault calls and GetLastError run on the same thread; native allocations are freed and write buffers are cleared. Await reads in snapshot capture, prepared-writer verification and local discovery. Await the primary write before synchronizing client files. Do not construct targeted native Entries on the Windows read or write path. The official credential location and raw UTF-8 JSON contract remain unchanged.

Service recovery requires old service identities to disappear and a replacement for each executable under the original main processes. Idle service counts need not be restored. An observation expiring at the recovery deadline is unconfirmed recovery; earlier query failures remain errors. This is a process-lifecycle contract and does not establish official UI connectivity. Before credential writes or service termination, select the normal close/write/start path for IDE instances with a directly owned machine AI service (IDE subclient without LSP enabled). Its owner has no automatic exit recovery; a workspace service running the same executable cannot replace it. The captured IDE closes before the account is written and receives one confirmed launch. This fallback closes IDE windows and interrupts their terminals. The decision uses observed service structure rather than a version or platform blacklist. No companion extension is installed.

## Consequences

No new dependency or process-query backend is introduced. Read failures remain explicit and cannot clear credentials. Native Windows exit verification can recognize an already completed shutdown without restarting a command. The operation retains its original deadline.

## Alternatives considered

Keeping per-service taskkill commands exhausted the hot-switch exit deadline. Reusing targeted native Entries preserved the destructive Windows constructor behavior. Treating unreadable exiting processes as absent would allow unsafe writes, while failing immediately interrupted completed shutdowns. Observation now obtains a fresh readable snapshot within its original deadline; persistent unreadability still fails.

## Verification

Focused credential, snapshot and discovery suites and a Windows Electron native integration exercise A-to-B-to-A writes and repeated nondestructive reads against a synthetic OS credential target. The native constructor reset was separately reproduced with synthetic credentials and cleaned up.

The full-restart regression suite verifies no preflight service termination, shutdown before account writes, and one launch after a machine-service fallback. Eight focused suites pass 89 tests; type checking and scoped lint/format checks pass. The Windows native integration fixture now redirects only the exact target, independently enumerates its raw UTF-8 contents, verifies A-to-B-to-A and repeated nondestructive reads, and deletes the synthetic target. This closes the false-positive coverage gap where the previous keytar fixture validated a different service/account credential.

Live acceptance uses npm run start, two authorized accounts, actual cloud-switch IPC, official GUI account identity and real synthetic AI requests after A-to-B-to-A. Both Windows and WSL IDE 2.5.5 complete full restart switching: the previous main identity disappears, exactly one new main remains, the official account matches, and each distinct chat marker is returned. Classic account identity is checked in official settings; CLI uses actual credential-backed userinfo and print-mode AI requests. The first Windows CLI attempt exceeded a 30-second test deadline without output. One later final-A strict assertion also failed; its initial detailed result was not retained, so its cause is not established. Immediate A identity/chat verification and a subsequent fully observed A-to-B-to-A cycle passed with a bounded 60-second deadline. No product-level automatic launch retry is added. See [testing](../../../../docs/testing.md) for acceptance requirements and the local ignored final evidence under test-results/issue-325.

Isolated service-termination checks without credential writes establish the recovery limitation: the WSL machine service did not recover, local UI requests used its dead HTTPS port, and only the workspace service recovered. Full restart restored real chat. A fresh Windows 2.5.5 instance also did not recreate the machine service for 15.7 seconds after individual termination. These observations justify the fallback, not a claim that service-only hot switching works on that structure. Bare-metal Linux and macOS account-switch acceptance remain unverified. No IDE extension is installed.

The final local evidence is recorded in `test-results/issue-325/final-acceptance-20261003.json`: all six Windows/WSL target combinations pass three account switches and real AI responses, for 18 verified cycles. Windows IDE account identity is checked in its official Account settings window because a custom editor profile changes the profile-menu presentation. Windows Classic and CLI pass after the exact-target credential correction; that correction does not change the IDE SQLite writer or Linux branches. Linux Electron additionally verifies the final source import and seven native SQLite checks. Temporary Windows debug arguments are removed, WSL original arguments are confirmed by readback, and the Windows IDE is reopened. Installer, physical Linux and macOS behavior remain outside this acceptance run.

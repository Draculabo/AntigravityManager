# Desktop Presentation Testing

This reference selects renderer, notification and preload evidence. Use [Testing](../../testing.md) for shared policy and [desktop security](security.md) for presentation/export limits.

Run commands from the repository root unless a step specifies another directory.

## Desktop workspace checks

Run `diagnostic-logs.test.ts` and `diagnostic-log-attachment.test.ts` for optional log attachments.
They cover whole-record removal, strict diagnostic projection, the ten-minute window, rotation,
size/missing flags, selected-owner failure, exact snapshot export, cancellation, retry and expiry.
`core-rpc.test.ts` also transports a near-limit synthetic core snapshot over the real private
pipe/socket. These checks never use production logs or submit a GitHub issue.

Run `error-toast.test.ts`, `toaster-feedback.test.ts`, `account-load-bug-report.test.ts` and
`cloud-account-load-error.test.ts` for notification diagnostics. They cover original/backend stack
selection, redaction, snapshot retention, dismissal, explicit reporting, clipboard/browser failures
and retry. The feedback workspace Electron check exercises the details dialog and keyboard close
with a synthetic stack; it does not submit a GitHub issue or expose real account credentials.

Run `pnpm run test:performance desktop-workspace.spec.mts` to check the production shell,
account page and Traffic Monitor in an isolated Electron window with synthetic data. The check
covers light/dark screenshots, supporting theme-color text contrast, a 900-pixel window, keyboard selection, proxy-dialog focus return,
navigation state, sidebar preference restoration and Chinese copy. Screenshots are saved in the
test output directory. The fixture has no real preload, credentials, database or upstream service;
this evidence does not establish installer behavior or macOS/Linux native integration.

The [desktop interface reference](desktop-interface.md) owns the presentation conventions.

Run `pnpm run test:performance feedback-workspace.spec.mts` to check deferred reads, empty account
and traffic views, failed reads with retry, and all four notification variants in isolated Electron.
It verifies visible close controls, keyboard dismissal, reduced motion and a 900-pixel window.
Read results and notification content are synthetic; reporting issues and authorization are not
performed. The focused traffic-feedback unit check additionally verifies that a failed background
refresh retains previously loaded records until retry succeeds.

Run `pnpm run test:performance settings-workspace.spec.mts` to check proxy configuration and
settings in the same isolated fixture. It covers keyboard tab and disclosure navigation, retained
tool-panel disclosure state, masked connection keys, start-confirmation focus return, protocol
selection, the settings theme switch and layout at 900 pixels. Screenshots include both themes
and narrow windows. This check does not start the proxy, save tool configuration, patch clients
or use real account data.

Run `pnpm run test:performance dialog-workspace.spec.mts` to check account sign-in, import/export
dialog dismissal, batch deletion cancellation, traffic-row keyboard activation and request details.
It verifies focus return, manual-code reset, translated status and metadata, retry after a failed
read, unavailable records, body selection, editor theme and a narrow detail window. Data and read failures are
synthetic; this check does not perform Google authorization, delete accounts or copy credentials.

Run `pnpm run test:performance tool-dialog-workspace.spec.mts` to check device information,
local account import preview, tool setup and configuration previews, and cache confirmation in a 900-by-700 Electron window.
It checks address validation, retry after synthetic read failures, scrolling with visible footer
actions, cancellation focus, focus return and a dark configuration preview. It does not change
device information, write tool settings, clear caches or use the system clipboard. Focused unit
checks exercise pending-action guards, local import cancellation and partial cache results.

## Renderer update profiling

Run `pnpm run test:performance playground-workspace.spec.mts` for Playground interaction checks
in an isolated Electron window. It loads production components with twelve synthetic accounts
and a controlled IPC fixture. Coverage includes the initial model selection, empty initial account
selection, select-all and comparison of more than ten accounts, checkbox and keyboard
selection, partial comparison failure and retry, light/dark and 900-pixel captures,
stopping and restarting dual requests, and
cancellation when leaving the tab. The fixture uses its own profile under the test output
directory and closes its Electron process and preview server. It does not use real credentials,
provider requests, persistence or the production preload. Selected-owner execution is covered
separately by the gateway adapter and core RPC integration tests.

Run `pnpm run test:performance renderer-updates.spec.mts` to measure account-page and
Traffic Monitor updates in isolated Electron windows. The fixture renders production
components with React Compiler and React Profiler, using 100 synthetic accounts and 50
synthetic traffic records. It has no production preload, database or provider connection.

The scenarios cover single-account selection, login input, account model availability,
statistics changes, queued traffic notifications on an older page and search input.
Component invocation counts are the regression gate. Profiler render durations are
diagnostic values from the local development renderer, not production latency guarantees.
Reports are written under `test-results/playwright-performance`.

For an optional Git comparison, set `AGM_RENDERER_PROFILE_BASELINE` to the commit to compare
before running the same command. The harness loads the relevant baseline source in memory;
it does not switch branches or modify the worktree. Run it again after changes to the account
selection store, account availability selector or Traffic Monitor state boundaries.

## Preload traffic events under Content Security Policy

Run `pnpm run test:acceptance runtime preload-csp --policy-timing initial` and
repeat with `--policy-timing after-preload`. The check builds the production preload
through Forge's Vite configuration and launches a real Electron window using the
current main-window execution settings in a temporary profile. It verifies that
the page rejects dynamic compilation, delivers 100 valid traffic events in order,
updates the visible count, filters invalid events, and stops callbacks after unsubscribe.
All temporary window/profile/build files are removed; sanitized reports remain under `out`.

Use `--expect-regression` only against the unfixed preload to confirm the same native
check detects event loss and compilation errors. A successful Node VM or Vitest check
does not replace this Electron evidence. The fixture uses synthetic events and does
not prove live-provider requests, the full Traffic Monitor React page, or installer behavior.

Run `preload-traffic-events.test.ts`, `preload-sandbox.test.ts`, and
`browser-window-security.test.ts` for the adjacent unit contracts.

## Performance recorder launcher

Run the real Windows command-shell smoke test for the performance recorder launcher:

```powershell
pnpm run test:performance-recorder-process
```

This process-level test uses a temporary `pnpm.cmd` fixture and runs outside Vitest's `no-app-launch` guard. It skips on non-Windows platforms; the default Vitest suite validates only the launch-command contract and does not start child processes.

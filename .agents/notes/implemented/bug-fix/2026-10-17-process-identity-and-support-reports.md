# Agent Note: Client identity and actionable support reports

Status: implemented

## Problem

[Issue 359](https://github.com/Draculabo/AntigravityManager/issues/359) demonstrates that a
third-party executable containing the product name is mistaken for the client and blocks
switch preflight. The production predicate reproduces this without starting any real client.
[Issue 358](https://github.com/Draculabo/AntigravityManager/issues/358) has matching process-close
events, but their generic process code cannot identify the underlying native failure.
Historical events cannot recover evidence discarded before capture.

The clipboard report contains only environment and additional context rather than the complete
issue template. Existing version 0.25.2 formatting already includes diagnostic and captured-event
IDs; the incomplete Issue body does not establish that generation omitted them. The application
does not generate interleaved translations of its diagnostic fields.

## Decision

The [switch-only forced cleanup decision](2026-10-27-account-switch-client-discovery.md) amends the account-switch close policy. Exact-name recognition, installation/profile isolation and diagnostic privacy below remain active; ordinary stops still respect normal-close refusal.

Identify discovered clients by exact executable basename or their application bundle, with
explicit configured/captured paths still supporting renamed clients. Product text in an unrelated
directory or later argument does not identify a client. Standard binaries from competing actual
installations still reach the existing path-conflict guard. Unreadable third-party metadata cannot
block observation. This recognizes supported binaries; it does not attest to their publisher.

Preserve typed process reasons and observed Win32 error codes through the original cause chain.
The shared diagnostic contract admits only those closed fields, never arbitrary native prose,
paths or command lines. Window-close, enumeration, missing-window and exit-timeout outcomes stay
distinct. Normal-close refusal remains a failure; the fix does not force termination or dismiss
save/cancel prompts. DLL acquisition and callback cleanup remain owned by the native adapter.

Re-observation after a failed close retains the original close cause when the probe also fails.
An expired exit-confirmation probe retains its own typed cause under the unconfirmed-exit result.
Neither recovery nor timeout wrapping may erase already observed native evidence.

The clipboard generator imports the checked-in Markdown issue template as its single source,
retains all user-editable sections and inserts redacted diagnostics and known environment fields.
Its immutable error snapshot retains the diagnostic UUID and captured-event ID. The fixed browser
URL carries no report text; users paste, review and submit the complete report. This keeps the
[report export policy](../../../../docs/modules/app-shell/security.md#error-details-and-report-exports).

Owner compatibility advances to `3` so a strict older diagnostic reader cannot attach to a core
that emits process observations and then lose the result after mutation. Management response
and diagnostic envelope versions are unchanged. See the
[standalone restart guide](../../../../docs/upgrade-guides/next/process-diagnostics.md).

## Alternatives considered

- Add third-party name exclusions: new tool names would recreate the same false positive.
- Ignore conflicting installations: risks closing or writing state for the wrong client.
- Force-close on missing windows or timeout: can destroy unsaved work and ignores cancellation.
- Forward native errors: leaks private paths or command content across diagnostic boundaries.
- Put report text in a GitHub URL: sends it before the user pastes and reviews the report.

## Consequences

Matching installed desktop/core builds must be restarted together. Supported desktop updates
manage the bundled core when the desktop launched it; externally managed cores require a separate
upgrade and restart. No data, credential location or persistence format changes. Existing
process-close events still lack their original native reason; the new evidence distinguishes
future failures rather than claiming an unverified repair
for every historical close error. A manually closed client remains a safe troubleshooting action.

## Verification

Regression tests cover false-positive names, incomplete metadata, supported binaries and genuine
installation conflicts. Window-adapter tests cover targeted close, missing windows, access denial,
enumeration failure, disappearing windows and cleanup after partial DLL loading. Cause tests check
the complete sanitized classification through terminal diagnostics, SDK projection and log export.
Two stop regressions reproduce cause loss when re-observation fails or consumes the close deadline.
The actual Node and Electron SDK adapters send six injected process failures to a local receiver,
which compares complete failures and both reference IDs. A controlled missing-process observation
fails that receiver check; the harness does not infer remote Sentry storage from capture or flush.
Clipboard tests compare template sections and complete output, retained IDs, redaction and existing
copy/browser failure behavior. Native acceptance uses isolated disposable clients, never account
credentials or installed applications. Live reporter incidents still require their own native
reproduction; fixture success cannot prove their historical cause.

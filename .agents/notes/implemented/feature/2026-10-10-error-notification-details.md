# Agent Note: Error notification details and explicit GitHub reports

Status: implemented

## Problem

The global error notifications discard caught exceptions after translating their user-visible
message. Users cannot inspect the stack or prepare a GitHub report from the notification, even
though the cloud-account load fallback already supports both actions.

## Decision

The generic toast boundary extracts and redacts an exception into a text snapshot immediately.
Callers with a caught error provide it explicitly; other notifications retain their plain-text
summary without manufacturing a stack. The app-shell composes notification actions and owns
the closable details dialog and GitHub workflow, keeping IPC out of the generic UI primitive.

The report builder is shared with the existing account-load report. Reporting requires a user
click, copies the environment and snapshot, then opens the fixed GitHub template URL. The user
reviews and submits the issue. The dialog remains independent of notification lifetime and stays
closable while asynchronous report preparation is pending.

## Alternatives considered

- Creating an Error inside the toast helper captures the helper stack instead of the failure.
- Retaining raw exceptions can keep provider payloads and account credentials in UI state.
- Expanding public IPC errors to include private backend stacks changes the security boundary.
- Encoding report contents in the GitHub URL exports diagnostics before the user reviews them.

## Consequences

Destructive notifications gain two actions and remain until dismissed or replaced unless a
caller supplies a duration. Existing actions and non-error notification timing are preserved.
Only details available under existing IPC sanitization can be shown; some operations expose
fixed public messages or a transport stack. Report failures preserve the original diagnostic
snapshot and permit retry. No account records, log files or new persistent stores are read.

## Verification

Focused renderer tests exercise the real toast state, stack precedence, redaction, notification
replacement, keyboard/explicit dialog close, report ordering, duplicate admission and retry.
Adjacent caller tests verify that caught exceptions reach the notification boundary. The
Electron feedback workspace check uses synthetic data and verifies narrow-window interaction.
Type, runtime-boundary, formatting and agent-contract checks cover the changed shared interface
and this decision record. These checks do not submit real GitHub issues or validate installers.

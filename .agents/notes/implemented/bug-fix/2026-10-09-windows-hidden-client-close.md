# Agent Note: Normal close for hidden Windows client windows

Status: implemented

## Problem

Issue 339's supplied 0.23.0 log records a Classic account switch failing at `stage=close` after
10004 ms with `exit-unconfirmed`. The unreadable-process warning alone does not identify the
cause: an isolated real Classic client emits the same warning while successfully exiting.

A controlled WinForms fixture proves that `taskkill /PID` can return without delivering a
close request to a hidden window. The process remains alive and the existing observer reaches
the ten-second deadline. A visible window that cancels closing produces the same final error.
These establish concrete mechanisms without attributing either one to the reporter's machine.

## Decision

The native Windows runtime uses the existing Koffi dependency to enumerate top-level windows
and post `WM_CLOSE` to unowned windows belonging to each freshly verified process ID. Hidden
windows participate. Window ownership is checked immediately before posting; owned dialogs are
excluded so save/cancel decisions remain with the client. The callback is unregistered and the
system DLLs unloaded after enumeration. Exit remains subject to the existing bounded production
observer. WSL keeps its existing Windows taskkill transport.

The initial native Windows close observation receives the operation budget instead of the
one-second status-query budget. Real standalone CLI acceptance found an unreadable retiring
process during this initial re-observation; it failed before sending close despite time remaining
in the ten-second operation. A 1.5-second snapshot regression locks down this case. If the initial
snapshot consumes the deadline, the runtime aborts before posting any close request. Metadata
must still become complete and the captured installation/profile must still match.

Cloud account switching reports `process-close-failed` when close fails, with localized guidance
to save work, resolve confirmation dialogs, close the client and retry. Startup failures retain
their existing category. A failed close does not write client credentials or activate the target
account. Token refresh may already have updated the Manager's local token cache.

## Alternatives considered

Forcing the process tree to exit can discard unsaved work. Raising the deadline cannot make a
hidden window receive an undelivered close request. Treating unreadable metadata as process
absence permits writes while a client may still be using the old account. Closing owned dialogs
can dismiss the user's save or cancellation decision.

## Consequences

No credential formats, database schemas or new native dependencies change. The new public error
category is consumed by the existing typed renderer error reader. This is a native Windows
improvement; hidden-window shutdown through WSL remains outside this change's native evidence.
Applications without closable top-level windows still fail safely if their process remains alive.

## Verification

The pre-change native hidden-window fixture fails with `exit-unconfirmed` after about ten seconds.
The updated production observer/close loop saves and exits visible and hidden accepting windows
in about 1.3–1.4 seconds. A refusing window receives `WM_CLOSE` but remains alive until the
existing deadline; cleanup terminates only the disposable fixture. Focused unit/transport,
native integration and repository contract checks accompany this change.

Electron 37.10.3 native integration additionally confirms that owned confirmation windows receive
no direct `WM_CLOSE` and are not destroyed after the application refuses closing. A real isolated
Classic 2.21.1 closes in 2574 ms, with Windows CIM independently confirming the process tree is
absent and the shared Windows credential restored. The no-window native launch fixture retains
all three fail-safe close cycles. Type checking, focused ESLint and formatting checks pass.

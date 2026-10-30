# Classic switching and restart recovery

The shared runtime coordinator handles both cloud accounts and local snapshots. The account
owner prepares credentials and captures the installation, arguments and profile before changing
the client. The selected account and captured launch context remain fixed through recovery.

## Route selection

Native Windows Classic with credential-store storage and an available terms owner attempts a
hot switch when dedicated AI service descendants can be identified inside the selected
installation. Other platforms, WSL-to-Windows, SQLite clients, missing services and unknown
layouts use the existing restart route. These compatibility conditions do not reject an
otherwise restartable client.

The hot attempt captures genuine consent history, writes and reads back the selected credentials,
retires the captured services, confirms their exit, reasserts credentials and observes new
services of each captured binary. PID, creation time, executable and ancestry establish service
identity. A workspace binary with a similar name is not a termination target. The main instance
must retain its original identity and profile.

On native Windows and Linux, a same-executable descendant is excluded from the main-process
set when both it and its nearest client ancestor explicitly select the same canonical data
directory. A different or unknown ancestor profile remains an instance boundary. Independent
roots and different installations remain visible to conflict checks. Missing profile arguments
do not imply a shared default or portable directory. This prevents retirement of a same-profile
helper from invalidating the surviving original main instance.

Classic also has to confirm that its official consent record belongs to the selected account.
This check waits up to five seconds for the official writer and never replaces a running
client's file. A fresh service process alone cannot establish account readiness. In particular,
Classic 2.23.0 can retain the previous account's consent slot after service replacement. That
observation selects full restart instead of reporting hot success.

These checks establish local lifecycle and consent evidence. Normal switching does not send
an automatic AI request or claim official provider acceptance from a PID or credential readback.
The [live acceptance procedure](account-switch-acceptance.md) checks official identity separately.

## Recovery and terminal boundaries

Each operation makes at most one hot attempt and one full restart. Hot preparation, credential
write/readback, service termination, credential reassertion, replacement and consent confirmation
failures enter restart recovery. The restart owner independently reobserves the original main
instance; it does not require the failed service observer to recover first.

Restart closes the selected tree, confirms exit, writes and reads back the same target account,
restores only genuine observed consent, launches once and confirms stable startup. Windows
uses the existing normal-close then identity-checked forced-cleanup policy. A pending save prompt
can therefore end in forced termination and loss of unsaved work. Credential writes after hot
failure are reconciled after full exit; the implementation does not pretend that the earlier
write was rolled back.

Unresolved installation/profile ownership, a user-closed or replaced main instance, updater
conflicts, unconfirmed full-tree exit, post-exit credential failure and uncertain dispatched
startup remain terminal. An uncertain exit prevents further credentials from being written;
an uncertain launch never triggers a second launch. Prelaunch terms recovery reports its own
failure alongside the initiating failure. A launch attempt prevents terms rollback against a
possibly running client.

## Diagnostics and presentation

One invocation identity spans account preparation, runtime attempts and final account-state
update. The runtime emits a closed `Switch trace v1` record; cloud and local owners retain it
for the single final report. Outcomes distinguish hot success, direct restart success, recovery
by restart and final failure. Active-account metadata is finalized once after a confirmed route.
A recovered operation returns success to UI and CLI.

The trace includes ordered stage starts and results, elapsed time, route, continuation decision,
credential/service/client effects, closed native/process classifications, bounded cause chains
and allowlisted source coordinates. It preserves the initiating and recovery failures separately.
The finite timeline allows up to 32 events with a 48 KiB byte budget; supplemental cause/frame
truncation is explicit. Tokens, emails, user paths, commands and original exception prose are
excluded. Supported sanitized log exports retain the validated trace.

The compact public diagnostic retains its 2 KiB budget and adds a recovery summary on attempted
recovery. Local snapshot errors preserve that diagnostic through owner, private RPC and desktop
IPC projection. Existing error details and CLI formatting display the same support reference.

Terminal Classic diagnostics also retain the coordinator's latest credential-write state:
`not-attempted`, `uncertain` or `confirmed`. Starting any write, including reassertion or restart
reconciliation, makes it uncertain until the prepared writer completes. A later failure cannot
reuse an earlier confirmed write to claim that the latest write completed. This field describes
the captured credential destination, not official-client account readiness or rollback.
The normal error presentation tells users to inspect the account shown in Antigravity before
retrying when credentials were written or may have changed; it does not turn the failure into
success or finalize active-account metadata.

Classic identity failures include closed ownership categories and bounded counts. They distinguish
missing or replaced mains, extra mains, unreadable metadata and failed observation without
retaining PIDs, executable paths, data-directory names or command lines. Unavailable observations
do not report a fabricated zero-process count. This evidence never authorizes process control.

Subject to existing reporting consent and availability, successful recovery produces one Sentry
warning tagged `recovered-by-restart`; terminal failure produces one error with both attempts.
The SDK projection preserves closed trace evidence and discards automatic account, request and
log data. A reporting failure cannot turn a completed switch into failure. See the
[diagnostic privacy policy](../../security/diagnostics.md) and
[verification reference](testing.md#classic-hot-switch-recovery).

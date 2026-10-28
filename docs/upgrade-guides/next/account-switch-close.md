# Upgrade guide: Save work before switching Windows client accounts

Target version: next

## Affected users

Windows Classic and IDE account switching, including Windows clients controlled from WSL,
can force the selected client tree to exit after normal close fails or its grace period expires.
This applies to cloud accounts and local snapshots. Ordinary start/stop controls keep their
existing normal-close behavior. Classic service hot switching is not introduced by this change.

## Required action

Save files and finish conversations before switching accounts. An unanswered save prompt or
an earlier cancellation does not prevent forced account-switch cleanup. If multiple installations
are discovered, select the intended executable in the existing settings. A stale configured path
can recover automatically only from an observed binary in the same installation directory.

## Data and recovery

Windows client startup confirmation, including WSL control, can now wait up to fifteen seconds
for stable process identity after one launch. A failed confirmation remains an error; Manager
does not launch another instance automatically.

Credential locations, database schemas and backup formats are unchanged. Forced termination can
discard unsaved client buffers and child-process work; Manager cannot restore those buffers.
On the normal restart path, client account writes wait for verified tree exit. Token preparation
may already have updated Manager's account cache, and an IDE hot-switch fallback may already have
written client credentials. A failed force or uncertain observation remains a failure; it does
not establish rollback. Save work, resolve the client state and explicitly retry after an error.

## Downgrade

No data conversion is required. An older build retains its prior close policy and can read the
same stored account data. Downgrading cannot recover unsaved work lost during forced termination.

## Verification

Focused tests cover role filtering, stale-path isolation, discovery and switch-only forced
cleanup. The isolated native launch runner verifies exit of its disposable process family;
it does not write live credentials or prove official-client account identity or history retention.
Native Windows and WSL live-client acceptance remain distinct environment-dependent evidence.
See the [process architecture](../../architecture.md#antigravity-process-operations) and
[runtime testing reference](../../modules/antigravity-runtime/testing.md).

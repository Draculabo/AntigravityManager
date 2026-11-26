# Agent Note: Sanitized log attachments for error reports

Status: implemented

## Problem

Error details can lack context from the selected runtime owner. Existing rotating logs contain
arbitrary provider text, model output and account metadata, so exporting a regex-redacted copy
cannot establish that it is safe to share.

## Decision

The app-shell owns a ten-minute diagnostic export with a 1 MiB aggregate ceiling. Each owner
reads its rotating mixed and dedicated diagnostic files. The shared logger writes selected
application-owned diagnostic text to the dedicated files after masking recognized credentials and
email addresses. A separate file family establishes provenance even if a line in a mixed file
resembles a diagnostic record. Mixed records retain their existing validated projection and removal
markers. Core raw logs stay inside the core. The desktop previews and retains the sanitized snapshot before
the user chooses a save location and manually attaches the exported text file to GitHub.

## Alternatives considered

- Automatic upload requires a separately agreed hosting, access and retention policy and is
  outside this feature's scope.
- Regex replacement over complete logs cannot safely distinguish private free text from
  diagnostic prose.
- A marker in a mixed log can appear inside a multiline message. File selection keeps ordinary
  log content out of the dedicated diagnostic path.
- Falling back to raw logs or a different core owner on failure violates the privacy and
  selected-owner contracts.
- Passing preview contents back from the renderer would allow unreviewed replacement content.
  A bounded, expiring main-process capability preserves the reviewed snapshot instead.

## Consequences

Attachments retain authored diagnostic prose and omit unclassified text from mixed logs.
Missing, removed and truncated content is visible. The independent error report retains its
available stack. Cancellation and save failure can retry the same snapshot. Export cannot
replace profile contents or modify the original log files.

## Verification

Focused tests cover masking during writes, separate files, timestamp ordering and bounded
attachment output. Desktop and private Core RPC tests cover ownership and snapshot handling.

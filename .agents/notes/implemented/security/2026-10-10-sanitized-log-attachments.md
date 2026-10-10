# Agent Note: Sanitized log attachments for error reports

Status: implemented

## Problem

Error details can lack context from the selected runtime owner. Existing rotating logs contain
arbitrary provider text, model output and account metadata, so exporting a regex-redacted copy
cannot establish that it is safe to share.

## Decision

The app-shell owns a ten-minute diagnostic export with a 1 MiB aggregate ceiling. Each owner
reads only its rotating log files and replaces uncertain records with a removal marker. The
projection retains validated diagnostic fields and a small set of exact fixed messages. Core
raw logs stay inside the core. The desktop previews and retains the sanitized snapshot before
the user chooses a save location and manually attaches the exported text file to GitHub.

## Alternatives considered

- Automatic upload requires a separately agreed hosting, access and retention policy and is
  outside this feature's scope.
- Regex replacement over complete logs cannot safely distinguish private free text from
  diagnostic prose.
- Falling back to raw logs or a different core owner on failure violates the privacy and
  selected-owner contracts.
- Passing preview contents back from the renderer would allow unreviewed replacement content.
  A bounded, expiring main-process capability preserves the reviewed snapshot instead.

## Consequences

Attachments intentionally lose free-text detail. Missing, removed and truncated content is
visible; the independent error report retains its existing available stack. Cancellation and
save failure can retry the same snapshot. Export cannot replace profile contents, and original
logs are unchanged. No durable formats, account access or telemetry consent switches change.

## Verification

Focused sanitizer, filesystem, desktop-service and renderer tests cover privacy, rotation,
window limits, size bounds, snapshot identity, cancellation, retry and expiry. The private core
RPC test reads synthetic logs inside the owner and validates the bounded sanitized response.

# Agent Note: Linux client profile ownership

Status: implemented

## Problem

Official Linux Antigravity erases profile arguments from process metadata. The directory guard consequently rejects an isolated running client. Restart normalization also converted Chromium's single `--user-data-dir=value` argument into two arguments; a real official-client comparison shows the latter does not select the isolated profile.

## Decision

Keep the directory option as one argument on restart. When Linux argv omits the directory, accept a profile only when its same-host singleton PID holds the profile's LevelDB lock file open. Confirm the candidate is that owner or a same-executable descendant, and recheck singleton ownership. Missing, stale, inaccessible or unrelated metadata remains insufficient evidence.

## Alternatives considered

Trusting configured arguments alone would authorize the wrong live profile. Ignoring missing arguments or accepting every process with the same executable would weaken isolation. Closing clients before every acceptance run hides the production failure.

## Consequences

The check reads Linux procfs and Chromium singleton metadata without reading credential contents. It fails closed when the profile lacks these artifacts. This evidence supports restarting a running client, not seamless in-process account changes. Windows and macOS retain their existing directory checks.

## Verification

Focused ownership and launch-context tests cover stale locks, another host, unrelated ancestry and ownership changes. Real Ubuntu WSLg acceptance reproduces the old rejection, confirms running-client snapshot success after the fix, and completes running-client cloud A-B-A switching with profile evidence retained after every restart. Complete CLI and Electron SOP reports each confirm six cloud/local switches and official account identity for Classic and IDE. One Classic Electron initial renderer navigation requires the recorded retry; that evidence does not establish a fault-free first navigation. Windows Classic CLI and Electron reports also confirm six switches and original credential restoration.

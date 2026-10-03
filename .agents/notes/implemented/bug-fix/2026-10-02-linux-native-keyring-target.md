# Agent Note: Linux native credential targets

Status: implemented

## Problem

Real WSL account-switch acceptance reached the native keyring fallback because
`secret-tool` was unavailable. Credential injection spent 301,873 ms in the
first switch, while D-Bus activated the GNOME keyring prompter. The complete
switch took 302,075 ms. A preliminary UI observation did not establish completion;
the persisted target setting and timing trace did.

The fallback passed the Windows credential target `gemini:antigravity` to
Linux Secret Service. On Linux, an explicit target selects a collection and can
request creation of that collection. It is not a portable credential name.

Post-fix acceptance exposed a second Linux credential mismatch. The official
Antigravity 2.19.1 language server returned `HasAuthToken=false` even when the
Manager's keyring token matched the selected provider account. A file-access
trace showed the server opening `~/.gemini/jetski-standalone-oauth-token` and
receiving `ENOENT`. A diagnostic write of the existing account's payload to that
official path made the application advance automatically to its terms/privacy
page; no additional OAuth login was required.

## Decision

Linux native reads and writes use `new Entry('gemini', 'antigravity')`, which
selects the default credential builder. Other platforms retain their current
target behavior. The existing bounded `secret-tool` path remains unchanged.

Explicit Linux Classic switches also synchronize the official standalone token
file with the same payload through the existing atomic private-file writer.
Initialization and replacement use file mode `0600`; write failures propagate.
The Classic injection adapter explicitly requests this synchronization. CLI
switches do not replace the Classic file, and other platforms do not create it.

The change does not delete credentials or alter token payloads.
Existing service/username entries remain subject to
the native backend's normal lookup and ambiguity rules; lookup failures remain
explicit errors.

## Alternatives considered

- Installing `secret-tool` in the acceptance environment would avoid this path
  without correcting the fallback used by installations that lack it.
- Pre-creating an application-specific collection would retain the wrong
  platform interpretation and require extra keyring administration.
- Changing every platform's builder would exceed the Linux issue demonstrated
  by this acceptance run.
- Requiring a manual official login would hide the missing credential write and
  invalidate the account-switch acceptance result.

## Consequences

The fallback no longer requests a Linux collection using the Windows credential
target. An unavailable or locked default Secret Service can still fail; this
change does not establish an execution deadline for synchronous native calls.

The standalone file is an official credential cache containing plaintext tokens,
not a Manager database or test fixture. Its use and permissions are documented
in the security reference. Both required Linux destinations must be writable;
there is no new fallback that silently accepts a partial update.

## Verification

A synthetic default-entry write/read/delete round trip completed in 21 ms in
the same private Secret Service session. Focused regression tests cover Linux
fallback reads and writes and preservation of the Windows target behavior.

After host disk recovery, a fresh WSL Manager session started through
`npm run start` and added two real accounts through its OAuth flow. Its isolated
Secret Service uses a persistent keyring whose unlock password is retained in
the host OS credential store; the earlier ephemeral test keyring was not
recoverable, and its original encrypted account database was preserved.

The initial classic target completed Manager-level A-to-B-to-A switches, but
the official window remained at its sign-in page. These observations were not
accepted as complete sign-in evidence.

After adding the official standalone file write and restarting `npm run start`,
the official 2.19.1 Settings displayed A, B and A after the corresponding Manager
switches, without a manual OAuth login. The human selected the first-run terms
and privacy options. A-to-B and B-to-A execution took 967 ms and 949 ms;
including OAuth preparation, the corresponding recorded durations were 1,530 ms
and 1,479 ms. Provider checks returned HTTP 200 and matched B and A. The official
main process changed on both switches. Restart also restored both encrypted
Manager accounts using the persistent test keyring.

Antigravity IDE 2.5.5 displayed the distinct A, B and A profiles in its official
Profile menu after the corresponding switches. Antigravity CLI 1.2.14 completed
the same sequence: its session credential matched each account through provider
user-info checks, and its real `models` command exited successfully for both
accounts. These observations validate their own paths; they do not establish
a deadline for a locked native keyring.

Focused regression validation passed 76 tests across six files on Windows and
13 tests across two files on WSL, including real Linux file permissions, cache
replacement, CLI separation and required-write failures. Type checking and
focused ESLint passed.

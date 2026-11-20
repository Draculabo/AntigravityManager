# Agent Note: Windows IDE Agent credential identity envelope

Status: implemented

## Problem

[Issue 442](https://github.com/Draculabo/AntigravityManager/issues/442) reports an account reverting
in Windows IDE 2.7 while Standalone remains running. The Windows IDE switch in Manager 0.32.1
updated the shared native item and left the fallback file in place. The official IDE and Standalone
backends can load credentials from that file when the native store is unavailable, and their
credential schema places `id_token_email` at the top level. The older Manager payload omitted
that field. The process responsible for the delayed overwrite in the report remains unidentified.

## Decision

Use the Agent identity envelope for ordinary Windows IDE 2.6 and later switches. Write the same
encoded credential to the native item and the standalone fallback file. Require exact readback
from both destinations before startup and retain the independent Agent identity check after launch.
Preserve the selected account's actual expiry and enterprise project. The
[runtime security reference](../../../../docs/modules/antigravity-runtime/security.md#windows-classic-credential-storage)
owns the destination and recovery contract.

## Alternatives considered

Using the existing token-only readback would accept a credential with a stale email if the token
fields matched. Terminating Standalone during an IDE switch would interrupt a second client. Live
verification showed that the IDE can start with the selected account while Standalone keeps running.

## Consequences

A concurrent overwrite can fail the full-envelope check after the SQLite write. The existing
native and SQLite backups remain available for manual recovery. Older payloads remain readable
through the existing credential reader. The switch still shares its native slot with Standalone,
so a later write from a separate process remains possible.

## Verification

The focused client-account writer test covers a stale identity field with matching tokens and
requires a matching fallback payload on success. The Windows native fixture exercises the
identity envelope through an isolated Win32 target. Live verification covered repeated switching,
a cold start, and a forced access-token expiry with Standalone running. The official client wrote
a new access token and expiry, and the IDE Agent still confirmed the selected account. The
delayed revert in the issue was not reproduced.

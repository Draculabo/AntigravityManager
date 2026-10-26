# Agent Note: Cloud switch lifecycle ownership

Status: implemented

## Problem

Cloud switching awaited refresh, project discovery and client preparation while
retaining an old account snapshot. Late work could inject replaced credentials,
write old token metadata or publish success for a changed account. Final Manager
selection, target setting, last-use and status were separate database operations.

## Decision

The cloud-account owner captures identity, creation time, complete token, proxy
and bound device profile. Only its own initial synchronous profile binding or
committed token update advances the expected values. Existing repository guards
check that context in token and finalization transactions. Provider project
discovery retains best-effort behavior; discovered-project persistence failures
remain fatal and diagnosable.

The runtime exposes an optional owner callback and checks it after awaited
preflight, around writes and before later lifecycle effects and success. It has
no dependency on cloud-account implementation. A changed-account failure must
survive the macOS best-effort reassertion catch. Existing local callers omit the
callback and keep their switching policy.

Finalization checks the context and changes global selection, target setting,
last-use and status in one existing SQLite transaction. Events and presentation
follow commit and another check. No schema, credential location, OAuth policy,
new retry or dependency changes are required.

Current behavior is owned by
[automatic switching](../../../../docs/modules/cloud-account/overview.md#automatic-switching).

## Alternatives considered

- Checking only before refresh or preparation leaves late results eligible for
  credential writes and success publication.
- Checking only after SQLite writes allows a stale task to mutate a replacement
  before detecting failure. Guards therefore execute in the write transaction.
- Separate finalization writes leave partial selection and status on failure.
- General credential rollback could overwrite a newer official-client write or
  acceptance. This slice stops later work and reports partial effects instead.
- A global transaction across provider waits, OS stores and processes cannot
  provide SQLite atomicity and would misrepresent recovery guarantees.

## Consequences

The original operation cause stays in owner diagnostics. No automatic retry is
added. Once dispatched, credential writes, profile effects or process start may
complete even if the account changes. Finalization rollback covers Manager
markers only. Classic terms keep their existing guarded pre-start rollback;
the diagnostic does not claim a general credential rollback.

Consent rollback verifies the restored consent fields through an official-file
readback before clearing its recovery ownership. A concurrent replacement or
missing file fails recovery. Startup and required hot-switch conversions retain
the original cause. Compound switch/recovery errors retain both classifications
under the existing four-cause diagnostic budget, with truncation recorded. The
cloud owner classifies the complete failure rather than discarding recovery
errors in favor of a remembered credential-write error. Trusted logs keep the
original errors; no raw error text or new public schema crosses the boundary.

macOS best-effort reassertion and profile behavior remain unchanged. Consent-only
recovery is distinct from credential recovery: the existing diagnostic rollback
field remains `not-attempted` for credentials. No automatic credential restore or
replay is introduced, and an attempted launch still prevents consent rollback.

Initial profile binding now follows the
[binding ownership decision](2026-10-17-initial-device-binding.md), including
incarnation/token/profile/history checks in its write transaction. Later D01
decisions own account incarnation, completion ordering and eligibility. Gaps
between the final check and external effects remain; this note still owns switch
context and Manager finalization. The
checkpoint (local artifact `D01-next-slice-checkpoint.md` in the 2026-10-11 review collection)
records current remaining lifecycle obligations.

## Verification

Four initial switch controls failed before implementation. Controlled tests cover
replacement during prepare/write, CLI and GUI lifecycle stops, macOS reassertion,
terms rollback, changed project/token results, preserved causes and failed
finalization without success. Native SQLite uses temporary synthetic profiles
and the installed Electron ABI to verify atomic markers, stale guards and rollback
on a failing target-setting trigger. No real account, keyring or installed client
is touched. See the
D01 switch report (local artifact `D01-switch-lifecycle-implementation.md` in the 2026-10-11 review collection)
for executed counts and retained failure evidence. Final checks pass 145 tests
across 17 files plus 21 native SQLite cases. The pure quota-prefix fixture now
mocks the actual switch owner rather than an obsolete IPC entry; its assertion
and deadline are unchanged. Intermittent Windows file replacement and sanitized
local-owner failures remain recorded with unknown host root cause.

The partial-failure report (local artifact `D01-client-partial-failure-implementation.md` in the 2026-10-11 review collection)
records six failing controls before the follow-up fix and a passing 16-file,
166-case focused matrix. Synthetic official-file tests replace or remove the
recovery result before readback; owner/runtime tests verify retained credential
effects, both failure causes, stopped finalization and no replay. An initial
loopback `EACCES` run remains recorded separately from the passing execution with
local test connections allowed. Real credentials, client launch and platform
keyring recovery remain unverified.

# Agent Note: Initial device binding and baseline publication

Status: implemented

## Problem

Manual profile binding awaited an account lookup, then wrote by ID without checking
that the row still represented that lookup. Initial switching checked context
before generation but not in its binding write. Both could overwrite newer profile
or history and bind a same-ID replacement. Global-original baseline creation also
used a separate existence check and replacing write, losing a concurrent creator.

## Decision

Cloud-account binding captures incarnation, identity, complete token/proxy context,
profile and history. The binding store requires this guard and reuses the existing
guarded-account transaction helper. Admission and profile/history writes share the
transaction. A matching already-bound profile stays a no-op; matching history must
materialize its profile before success without adding a duplicate revision.

The switch advances only its own committed profile. Manual baseline fallback
publication follows the guarded database commit, so a stale or failed binding
cannot install its candidate baseline. The public profile failure categories remain
unchanged, while the trusted error retains the original cause and log stack.

Identity-profile baseline and desktop-storage initialization use the same owned
exclusive publication helper. It writes a private sibling file before linking the
complete inode into a missing destination. A concurrent destination is preserved.
Publication and cleanup errors remain independently diagnosable, with an aggregate
when both fail. Existing targets are never repaired or replaced by this helper.

Current behavior is in the [binding reference](../../../../docs/modules/cloud-account/overview.md#device-binding-ownership)
and [baseline reference](../../../../docs/modules/identity-profile/overview.md#global-original-baseline).
The [switch lifecycle decision](2026-10-16-cloud-switch-lifecycle.md) still owns
the independent official-client and Manager finalization boundaries.

## Alternatives considered

- Another service-level read leaves the read-to-write gap and cannot establish
  SQLite mutation ownership.
- Adopting a concurrently stored profile would change an admitted operation's
  intent and conceal a replaced identity or changed credentials.
- A process-local mutex cannot fence an existing database snapshot or a competing
  file creator and adds cancellation/lifetime ownership.
- Saving a generated baseline before binding can preserve a rejected candidate.
- Direct exclusive writes prevent overwrite but expose a partial baseline on write
  failure. Atomic replacing writers do not preserve another creator. Reuse the
  existing identity-file complete-inode publication mechanism instead.

## Consequences

Profile/history writes roll back together on failure. A later baseline error does
not roll back a committed binding; the caller must inspect the current snapshot
before an explicit retry. A cleanup error can follow successful file publication.
No automatic retry, global account/file transaction, schema migration, durable
binding clock, credential location or dependency change is introduced.

Account history changes conservatively invalidate a waiting binding. Explicit
revision restore/delete keep their current policy. A global baseline remains the
first complete published file, including when another account supplied it. Corrupt
existing bytes are not replaced. Cross-owner final-check/effect gaps, unsupported
hard links, crash/power-loss durability and real-client partial-effect recovery
remain separate limits.

## Verification

Initial controls reproduce 20 failures and 5 passes before implementation. Native
SQLite barriers cover manual and automatic binding after replacement, token,
profile and history changes, final write admission, atomic rollback, missing-profile
history reuse and a later baseline failure retaining committed state. File tests
cover a competing creator, complete publication, preservation of existing malformed
bytes, ordinary failures and combined publication/cleanup failure. Transport tests
retain the public profile categories and privacy policy.

Commands and counts are recorded in the
implementation report (local artifact `D01-initial-device-binding-implementation.md` in the 2026-10-11 review collection).
All account/provider/process inputs are synthetic or substituted. Real acceptance
remains deferred; no credentials, official clients or subagents are used.

# Agent Note: Import and lease commit ownership

Status: implemented

## Problem

Import planning and commit were separated by asynchronous preparation. A whole-row
upsert could restore a deleted account or discard a concurrent token, quota, health
or active-account update. Lease-local cache checks could not detect a durable
replacement before cache reload, or a replacement inside an adapter's write wait.

## Decision

Import transactions compare the original planning snapshot before account/active
mutations. Shared row encoding avoids defaults and optional JSON fields producing
different equality rules between single and batch writers. New identity/grant claims
and changed active selection reject obsolete plans. File imports retain per-row
completion; local discovery retains all-or-nothing commit. Grant-replacement
follow-up checks token and health ownership before clearing failure evidence.

Each loaded lease entry retains a private stored identity/token baseline. Its
adapter forwards synchronous guards into existing repository transactions and the
health mutation owner. Successful queued token persistence advances only that
entry's baseline. A baseline advance invalidates older cache loads. The baseline
is not returned over a protocol, logged or persisted as a new format.

Current behavior belongs in [import ownership](../../../../docs/modules/cloud-account/overview.md#import-commit-ownership)
and [account leases](../../../../docs/modules/proxy-gateway/account-leases.md#deleted-account-cleanup).

## Alternatives considered

- An asynchronous pre-write reread leaves a gap before the actual store mutation.
- Cache identity alone cannot observe imports that have committed but not reloaded.
- Always adopting the latest row would let an old provider result overwrite a new
  token with unchanged account ID. A whole-token guard also protects metadata.
- A global lock across provider work would delay unrelated accounts and would not
  fence independent processes. SQLite retains its existing transaction ownership.
- New durable generations would change storage and require a separate identical-
  value lifecycle decision. This slice uses the existing representation.

## Consequences

Conflicts fail without automatic replay. Previously committed file-import rows,
provider effects and accepted lease responses are not rolled back. Background
token-save rejection remains diagnostic and does not retroactively undo a returned
lease. Stored comparison does not order independent quota results within unchanged
token context, or distinguish identical-value delete/recreate. Late generation
penalties, Google enrollment follow-up, persisted preference cleanup and gaps after
the final check remain separate D01-R12 work. D01 is not complete.

## Verification

Five controlled import overlap tests failed before implementation. Focused tests
cover guarded import handoff, durable deletion/replacement, batch rejection before
any write, new identity/grant claims, active selection, lease token/quota/validation
write waits, own-baseline advancement and stale-load rejection. SQLite unit tests
use disposable synthetic profiles with pinned Node 24; they do not exercise live
Google accounts, packaged Electron or the separate runtime used for comparison. Electron execution
is unavailable with the currently installed Node-ABI SQLite binary.

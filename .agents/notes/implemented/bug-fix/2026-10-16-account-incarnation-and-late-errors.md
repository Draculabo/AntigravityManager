# Agent Note: Account incarnation and late request errors

Status: implemented

## Problem

Field equality cannot distinguish deletion followed by a same-ID, identical-value
insert. Penalties retained only the account ID and could punish that replacement.
Deletion also left the saved preferred-account ID behind.

## Decision

Storage assigns a random incarnation on insert. An additive column, backfill and
insert trigger migrate transactionally. Updates preserve it; old-column inserts
receive a new value. Trusted contexts compare it alongside identity and token
guards. Exports and renderer views omit it. Writers ignore copied incarnations
when inserting new rows.

Issued leases have weak completion ownership. Error execution carries that check
through quota and health waits into later mutations and availability persistence.
It checks cache identity, captured credentials and synchronous current-storage
proof. Stale work retains its request error and releases image permits without
creating a grace retry. Failed proof cannot authorize penalties.

Preference cleanup follows deletion through the configuration queue. Strict fresh
reads cannot replace corrupt configuration with defaults. Both runtime and file
cleanup are attempted, preserving independent causes. A recreated account or
newer preference is preserved. Shutdown drains admitted account work before
closing the configuration queue it may still need.

Current behavior is in [leases](../../../../docs/modules/proxy-gateway/account-leases.md#late-request-errors)
and [accounts](../../../../docs/modules/cloud-account/overview.md#stored-account-incarnation).
Recovery limits are in the [upgrade guide](../../../../docs/upgrade-guides/next/account-incarnation.md).

## Alternatives considered

- Comparing fields still admits a same-value replacement. Process-local deletion
  flags cannot identify all stored incarnations and risk unbounded tombstones.
- Changing incarnations on every update would invalidate the writer's own token
  refresh/project chain and unrelated concurrent work.
- An initial penalty check leaves later quota/health waits unguarded.
- Writing configuration outside its queue can lose unrelated changes. SQLite and
  JSON do not share one distributed transaction.

## Consequences

No provider retry, credential location or export format changes. The migration
fast path performs no generation writes once the column and trigger exist. Invalid
stored incarnations reject reads. Preference failure cannot roll back deletion.
Explicit deletion retry is a new deletion by ID; inspect the current list first.

Independent late-success cleanup, Google enrollment follow-up, same-context quota
ordering, configuration writers outside the owning queue, and effects already
dispatched remain separate D01 obligations. Database restore requires stopped
owners; incarnations cannot fence replacing a running profile with an older backup.

## Verification

Two initial same-value controls failed before implementation. Controlled tests
cover stale token/import rejection, issued-lease rejection before cache reload,
stable upserts, export omission, five HTTP statuses, grace permits, quota fallback,
strict configuration reads, serialized updates, independent cleanup failures and
shutdown admission order. SQLite tests cover reopen, old-column writers, rollback
and stopped-owner backup recovery with synthetic accounts under pinned Node 24.
Live-provider, client interoperability and packaged Electron acceptance remain deferred; D01
is still in progress.

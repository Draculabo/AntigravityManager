# Agent Note: Account Lease Background Token Persistence

Status: implemented

## Problem

The account-lease hydration path awaited encrypted SQLite persistence after refreshing an access token or resolving a project ID. The repository performs synchronous database work around asynchronous encryption, so durable writes could extend account selection latency even though the refreshed state was already usable in memory.

## Decision

The hydration policy updates the selected token and account cache first, snapshots the resulting token state, and enqueues durable persistence for the next event-loop turn. Queues are serialized per account and independent across accounts. This preserves refresh-then-project ordering and prevents an older delayed snapshot from overtaking a newer update. Every background failure is caught and logged without rejecting the lease that already succeeded.

Only lease-time refresh and project-ID hydration use this queue. Other repository writes keep their awaited behavior. The persistence repository, encryption format and SQLite schema are unchanged.

Graceful Nest module shutdown drains the queue before the account-lease service is destroyed.

## Alternatives considered

- Removing `await` without deferring execution can still run synchronous database work before the caller resumes and allows unordered completion.
- A global queue would unnecessarily serialize unrelated accounts.
- A worker-thread SQLite subsystem would require a broader persistence and key-management redesign than this hot-path fix.

## Consequences

Requests can immediately consume refreshed credentials and project state. Same-account writes preserve enqueue order, while different accounts can persist concurrently. Graceful shutdown waits for queued writes; an abrupt process exit can lose the latest deferred update, and the next refresh or project-resolution cycle repairs it. Logs contain only the account ID and error, never token values.

## Verification

`account-lease-hydration-policy.test.ts` proves that hydration returns before persistence starts, refresh and project snapshots persist in order, different accounts progress independently, and persistence failures are logged without failing token selection.

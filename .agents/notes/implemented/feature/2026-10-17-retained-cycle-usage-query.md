# Agent Note: Retained usage reads for official quota cycles

Status: implemented

## Problem

D02 needs a current provider-cycle view without conflating it with calendar-week
statistics or authoritative quota. The existing audit database records parent usage,
physical attempts, account IDs and request-start times. It does not retain complete
history, per-attempt token usage or account lifecycle generations. Assigning a
parent's usage to its preferred attempt after retries can misattribute consumption.

## Decision

The cloud-account owner derives current weekly bounds from the original offset-bearing
reset. It rejects unavailable windows instead of inventing the next cycle. The audit
owner supplies a bounded exact-account/exact-model range query through its existing
selected desktop/core transport, serialized admission and worker queue.

The worker aggregates scalar metadata in one prepared SQL statement. Only complete
terminal parent usage with exactly one matching completed upstream attempt contributes.
Ambiguous ownership and missing usage are separate counters. Input plus output is
the total; cache is separately reported with its own missing-data count. Accumulated
values outside JavaScript's safe integer range are rejected. Queries neither replay
generation nor write derived totals to quota/account storage.

Results explicitly identify retained local coverage, account-ID-only attribution and
request-start time semantics. The existing timestamp index and audit schema remain
unchanged. A strict input limits each read to seven days, 128 exact model names and
bounded strings; only a scalar result crosses the worker and private RPC boundaries.
There is no new archive, backfill, recorder or provider request.

## Alternatives considered

- Summing displayed integer quota percentages cannot measure token usage.
- Adding cached/reasoning quantities again would double count reported usage.
- Treating missing usage as zero hides incomplete records.
- Choosing the latest/successful attempt cannot prove ownership of parent usage.
- Guessing all Claude/GPT models belong to one provider group can mix distinct quotas.
- Reusing an account ID does not identify a historical account incarnation.
- Creating another archive or adding per-attempt/generation fields now would require
  a separate durable-format decision, migration/recovery and collection evidence.

## Consequences

This is a query foundation, not completed official-cycle UI or full D02 acceptance.
The later account-card consumer must resolve D08 group membership and explain
historical identity/coverage limits. The public query never promises complete history
or all-channel provider consumption, including when its retained subtotal is zero.
Retries and token refresh may introduce additional attempts; excluding those parents
is deliberately conservative until per-attempt usage attribution exists.

The operation uses existing shutdown and error owners. Original service failures
and stacks reach trusted diagnostics; the transport exposes the existing fixed audit
failure. Failure never returns a successful empty summary and no retry is added.
No SQL schema, credentials, retention, generation-protocol or release behavior changes.
Reverting the query needs no data migration because it has no durable writes.

## Verification

Native temporary SQLite fixtures exercise production repository dispatch, exact
scope, half-open boundaries, missing and ambiguous data, cancelled/failed usage,
idempotent reads, SQL parameterization and numeric overflow. Public owner/client
tests exercise both selected owners and a local private RPC transport. Service
tests substitute the worker to verify captured time, diagnostics, failure and shutdown.
They do not establish the compiled worker artifact, packaged Electron or real-provider
behavior.

The selected regression runs cover a union of 137 files with 1,471 passing tests and
one inherited Electron-ABI-specific skip; overlapping runs are not added together.
The new native SQLite usage-query tests ran without skips. The final scalar-query
selection passed 48 tests in four files, followed by 21 owner/service tests in two
files after correcting the desktop error projection. Negative controls detected
offset-free cycle timestamps and private error text escaping that projection.
Type checking, focused lint/formatting, runtime boundaries and Agent contracts passed
for the slice using the pinned Node 24.22.0/pnpm 10.34.6 runner.

These are historical controlled results, not a fresh validation of the current
workspace. The local `D02-cycle-usage-query-implementation.md` report under ignored
`artifacts/` contains detailed commands and logs; this note retains the conclusions
and limits without requiring that local report in a checkout. No complete provider
coverage, account incarnation, group membership or final D02 acceptance is inferred.

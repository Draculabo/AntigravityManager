# Agent Note: Retained usage reads for official quota cycles

Status: implemented

## Problem

D02 needs a current provider-cycle view without conflating it with calendar-week
statistics or authoritative quota. Assigning a parent's usage to its preferred
attempt after retries can misattribute consumption. Account IDs alone cannot
distinguish a deleted row from a later account that reuses that ID. A verified
Google account also needs continuous usage when it is added again under a new local ID.

## Decision

The cloud-account owner derives current weekly bounds from the original offset-bearing
reset. It rejects unavailable windows instead of inventing the next cycle. The audit
owner supplies a bounded exact-identity/exact-model range query through its existing
selected desktop/core transport, serialized admission and worker queue.

The selected lease carries the storage-owned lifecycle generation. The physical
send snapshots its SHA256 digest, account ID, model and generation/non-generation
scope. A weakly held usage accumulator observes actual unary responses and raw
parsed SSE frames before semantic rejection. Existing once-only attempt completion
persists known safe counters even for failures and cancellation. Provider responses
and public protocol usage remain unchanged.

Audit schema 6 retains scalar attempt usage, scope and generation-digest columns
and adds private subject and grant digests. Versions 4 and 5 receive a verified
SQLite `VACUUM INTO` backup before the additive migration. The backup's version and integrity are checked and its file synchronized
before the additive migration transaction. Failure stops initialization; no empty
replacement database is created. The older prototype policy remains separate.

Fresh Google user-info establishes a private subject proof bound to the OAuth grant.
An access-token digest binds access-only accounts; a refresh-token digest is used
when available. Both bindings include the OAuth client key.
The account owner stores only domain-separated digests in a nullable private column.
Imports and credential replacement cannot supply or inherit that proof. Trusted
refresh rebinds a previously valid proof atomically; other token writes preserve it
only when the binding remains unchanged. Neither email nor an unverified ID-token
payload proves identity. Existing accounts and records receive no guessed backfill.

The worker aggregates matching verified subject attempts across local account IDs
and lifecycle generations. Accounts without proof use current-incarnation and exact
grant scope. Historical rows missing the identity metadata needed for their scope remain
ambiguous without contributing tokens. A cleared subject proof does not remove
same-incarnation, same-grant attempts from the conservative fallback.
The account owner resolves current identity before querying and checks it again
afterward. A changed or deleted account fails that read. The selected lease snapshots
subject identity and derives grant identity from the actual fulfilled token before
the physical send, including a token refreshed before deferred persistence. Raw identities, proof and all
private digests stay out of public results, account exports and audit exports.
Core owner compatibility 9 rejects mixed application/core contracts before RPC.

Requests are distinct parents within the selected identity/model scope. Complete,
missing/partial and ambiguous classifications are disjoint. Known terminal attempt
scalars contribute to the subtotal even when sibling attempts are incomplete.
Legacy unknown identity/scope contributes ambiguity, never parent-token attribution.
Input plus output is the total; cache is separate. Unsafe accumulated counts fail.
Results identify retained-local coverage, verified-Google-account or current-incarnation
attribution, and attempt-start time. Queries stay bounded to seven days and 128 exact model IDs.
There is no new archive, backfill or provider request.

Legacy parents without physical attempts or potentially matching missing attempt
identity contribute ambiguity markers within their request-start window, never
tokens. The public `ambiguousTimeBasis` states that fallback explicitly. Grouping
deduplicates the markers and physical attempts. Malformed/oversized SSE parser
failures retain known counters while marking usage incomplete, including raw text
passthrough. No diagnostic parser failure changes provider forwarding or retry policy.

## Alternatives considered

- Summing displayed integer quota percentages cannot measure token usage.
- Adding cached/reasoning quantities again would double count reported usage.
- Treating missing usage as zero hides incomplete records.
- Choosing the latest/successful attempt cannot prove ownership of parent usage.
- Guessing all Claude/GPT models belong to one provider group can mix distinct quotas.
- Reusing an account ID does not identify a historical account incarnation.
- Parent-only usage cannot allocate retries across accounts or models.
- Guessing logical-account continuity from matching email or IDs can join unrelated
  account incarnations. Only the provider-authenticated user-info result establishes
  a logical identity, bound to the observed grant.

## Consequences

This implements verified logical-account continuity for attempts recorded with the
new proof, plus a conservative current-incarnation/grant fallback. It does not
complete D02 provider model-group membership or acceptance. Unknown historical
identity remains explicitly incomplete. The public query never promises
complete history or all-channel provider consumption, including a zero subtotal.

The operation uses existing shutdown and error owners. Original service failures
and stacks reach trusted diagnostics; the transport exposes the existing fixed audit
failure. Failure never returns a successful empty summary and no retry is added.
Account and audit migrations need temporary space for private SQLite backups. The
account column stores only an optional proof; existing credential, quota and other
account bytes are preserved. Audit schema 6 cannot be opened by schema-4/5 binaries.
Offline downgrade requires preserving schema 6 and restoring the verified pre-upgrade
audit backup. That copy omits subsequent audit history. Thought Store and provider
protocols retain their formats. See the
[upgrade guide](../../../../docs/upgrade-guides/next/physical-attempt-usage.md).

## Verification

Historical native temporary SQLite fixtures exercised production repository dispatch, exact
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

These are historical controlled results for the earlier parent-based query, not
validation of the schema-5/6 capture, identity proof, migration, recovery or aggregation. All test
editing and executable validation for the current slice are deferred by the user.
Existing typed fixtures still require the new private worker fields and result
literals before the selected suites can establish current behavior. The local
`D02-cycle-usage-query-implementation.md` report under ignored
`artifacts/` contains detailed commands and logs; this note retains the conclusions
and limits without requiring that local report in a checkout. No complete provider
coverage or final D02 acceptance is inferred. Verified identity continuity, credential
replacement isolation, refresh rebinding, schema-6 preservation, backup readback and
offline recovery require focused executable evidence once validation resumes.

The 2026-11-06 logical-identity continuation received independent static review.
It corrected same-grant fallback after import cleared subject proof and a stale
lease grant digest after asynchronous token refresh. Both fixes received focused
source review with no open findings. Source inspection is not runtime acceptance.
No tests, type-check, lint, build, migration, backup/restore or provider calls ran
for the continuation.

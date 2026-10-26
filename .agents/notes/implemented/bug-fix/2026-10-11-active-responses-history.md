# Agent Note: Pending output ownership and indexed tool repair

Status: implemented

## Problem

An accepted compacted or replacement WebSocket transcript left the old completed output in
a separate pending-output field. If generation then failed, the next append reintroduced
discarded text. ID-less output could also be appended more than once. The complete socket
tool cache was copied and reindexed on every append even when only one orphan result needed
repair; compacted history did not make that work bounded by the current transcript.

## Decision

Treat completed output as a single pending transcript contribution. After request preflight
succeeds, publish the merged/replacement request and clear that pending reference. Preflight
failure leaves the prior request and pending output available. A later generation failure
does not undo an admitted compaction or add the old contribution again.

Move tool identity and orphan repair into a Responses-owned module. Durable histories provide
arrays; WebSocket provides its existing read-only call-ID index. Reuse the latter for direct
lookups instead of materializing all cached values and reconstructing the same index. Preserve
last-entry-wins array indexing, ordering, duplicate repair suppression and ID fallback.
Do not change stored schemas or durable encodings.

The [current reference](../../../../docs/modules/proxy-gateway/diagnostic-retention.md#responses-websocket-pressure)
owns active-history and aggregation limits.

## Alternatives considered

Deleting all historical tool calls on compaction would break late orphan-result repair.
Neither a fixed cache cap nor arbitrary expiry is justified by the existing continuation
contract. Keep those calls and make lookup work proportional to needed repairs.

Clearing pending output before preflight would lose a valid contribution when request
validation fails. Waiting for the next completed response would retain stale output and
restore it after admitted compaction followed by failure. Request admission is the owning
commit point for transcript assembly.

## Consequences

Compaction releases discarded pending message text immediately after admission. Ordinary
append still retains its accepted message text in the effective transcript. Historical tool
arguments and active transcript size remain unbounded by output/ingress budgets. A native
2,000-turn compacted tool fixture keeps all 2,000 calls, while eliminating enumeration of
roughly two million historical cache entries. This reduces repeated work without claiming
that the cache became bounded.

Concurrent unary collectors retain separate fragments and results; synchronous JSON parsing
does not imply a shared memory ceiling. This change measures that exposure and does not
introduce global admission, automatic compression, retries or silent truncation. Credential,
provider and durable persistence behavior remain unchanged.

The [aggregation admission decision](2026-10-11-aggregation-admission.md) subsequently bounds
fallback stream starts and waiters. Byte accounting and caller-owned results remain outside
that count/time policy.

## Verification

Minimized regression tests fail before this change on compacted-output resurrection,
duplicate ID-less output and full-cache enumeration. Coverage verifies rejected preflight,
full transcript replacement, late function/custom results and array/index repair equivalence.
Existing protocol, session-store, durability and real-path parity tests cover shared consumers.

Native loopback acceptance sends a large completed response, admits compaction, forces a
generation failure and verifies the next effective request. Before/after captures measure
pending-output memory and retained input items. A separate native long-session fixture
checks indexed late-result repair. One/four interleaved 16 MiB collector fixtures preserve
all response hashes and disclose concurrent retention. These synthetic local checks do not
establish installed Electron, live-provider or global RSS behavior.

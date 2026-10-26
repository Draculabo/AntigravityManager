# Agent Note: Shared unary aggregation admission, cancellation and byte ownership

Status: implemented

## Problem

Four incomplete unary requests created four fallback streams immediately. A cancelled request
could still be collected when a provider ignored its signal. Gating after stream creation
would leave upstream buffers retained in the waiting queue. Local pressure also needs to
avoid provider account penalties and repeated quota-consuming attempts.

## Decision

Admit fallback stream creation through a process-owned FIFO gate shared by all protocol
services. Use two active credits, eight waiters and a 30-second waiting deadline. The native
one/four-collector audit motivates limiting simultaneous owners; the deadline and finite
queue prevent indefinitely retained waiting operations. These initial limits are internal
policy, not provider-window or RSS estimates, and do not affect complete unary generation.
The [current reference](../../../../docs/modules/proxy-gateway/diagnostic-retention.md#unary-stream-aggregation)
owns limits and externally visible failure behavior.

Discard incomplete direct results before waiting. Store cancellation callbacks and metadata
in queue entries, without another body or credential copy. Cancel/expire entries by removing
the timer and signal listener before rejection. Publish a granted credit before resolving the
waiter, and make release idempotent to prevent oversubscription.

Race an admitted provider start against request cancellation. Keep its credit until the actual
provider promise settles if it ignores cancellation; destroy a late unconsumed stream. Active
collection owns a request-signal listener as well as stream listeners, clears partial state
on abort and releases its credit on settlement.

Return a local 503 for queue full/timeout. Stop before account penalty, account rotation or
retry, including nested Anthropic project/model fallbacks, and release any image permit.
Transport disconnect uses the existing request AbortSignal surface.
Request cancellation is normalized to the shared AbortError contract and bypasses account
failure recording as well as retry. Cancelled requests do not make healthy accounts unhealthy.

Keep numeric byte ownership alongside count admission and collection. Measure the translated
request only when fallback is needed, before waiting; transfer its charge at promotion and
retain it through an uncooperative provider start. Collection owns separate incremental part,
metadata, line and temporary decode charges, releasing them when the response transfers to
its caller. This provides ownership evidence before selecting any aggregate byte threshold.
The estimator walks JSON fields without another serialization; its conservative assumptions
and measurement scope belong in the linked current reference.

Count scalar fields inside their object frame instead of creating iterator results for each
key and primitive. Keep identity deduplication for translated request graphs, which can share
schema or argument objects. The fresh decoded JSON tree has no aliases/cycles and uses the
same weights without an identity set; collection predicates remain pure. This avoids large
identity-set allocation and GC overhead during dense upstream tool-argument accounting while
preserving the byte ledger. Do not apply the tree-only path to translated or mutated values.

Pause collection at cooperative checkpoints while keeping a single input owner. Decode
bounded windows instead of converting the entire incoming Buffer to a string. Keep the
window iterator across event-loop turns and clear it on every terminal path. Work budgets
span source chunks so bursts of small chunks cannot bypass yielding. End is a source signal,
not permission to release the admission credit before pending input has been consumed.
The current reference owns checkpoint sizes and the remaining synchronous-operation limits.

## Alternatives considered

Creating upstream streams before admission would retain or consume responses while queued.
Releasing a cancelled pending-start credit immediately would permit unbounded uncooperative
provider operations. Awaiting that operation before returning cancellation would retain the
request waiter indefinitely. Separate caller completion from provider credit settlement.

Serialization of every queued request introduces large transient allocations. A guessed
aggregate byte rejection threshold can also reject legitimate histories and media. Count/time
limits precede numeric accounting; the latter intentionally adds diagnostics without a new
rejection policy. Measuring all accumulated parts after every event would make collection
quadratic; measure only new parts and replacement metadata.

Scheduling only between source chunks leaves a single large Buffer uninterruptible. Queueing
chunks after pause would add another unbounded owner. Resume the source only after pending
input is drained; reject a source that violates pause rather than silently losing data.
Moving parsing into a worker would introduce another transport, copied state and cancellation
boundary; keep that separate from cooperative collection. No automatic retry is introduced.

## Consequences

Active fallback concurrency is bounded and waiting work can be removed before its upstream
call. A never-settling provider start holds a credit; later waiters expire rather than
accumulating hidden operations. Complete unary generation and caller-owned completed results
remain outside the gate. There is no global RSS ceiling: native four-result acceptance keeps
all results, and its observed OS high-water mark does not establish a memory reduction.
Numeric byte accounting also adds traversal work and weak identity membership allocation;
overlapping phase aliases and engine string storage prevent an exact heap interpretation.
Collection still walks a current response and its accepted subtrees separately. Large JSON
parses and dense estimates remain synchronous; lower measured cost does not establish a
hard fairness deadline, RSS limit or production latency guarantee. Cooperative checkpoints
let cancellation and other callbacks run between events/windows, but an atomic large event
can exceed the target work interval. Yielding also adds scheduling latency to unary completion.

Limits can add latency or local 503 under load. Credentials, persistence, ordinary upstream
retry behavior and protocol output content remain unchanged. Actual providers and packaged
shutdown behavior need separate environment evidence.

## Verification

The pre-change regression creates four fallback streams where the new contract admits two.
Focused tests cover FIFO, overflow, timeout, already cancelled requests, idempotent release,
listener removal, active cancellation, late-result ownership and all three services' local
non-retry behavior for overflow and waiting cancellation. Provider cancellation before fallback
also normalizes without starting a stream. Existing real-path and fallback parity checks cover protocol consumers.

Native fixtures verify four complete text hashes with at most two active starts, waiting
cancellation before stream creation, the real 30-second deadline, full admission, HTTP
disconnect and late stream destruction. WeakRef/GC probes confirm waiting request objects
become collectible after cancellation, timeout and overflow. Active abort, stream error and
creation rejection release credits and listeners. Synthetic fixtures do not establish a
provider memory ceiling or installed Electron behavior.

Byte regressions cover complete waiting bodies without serialization, promotion, timeout,
overflow, cancellation, pending-provider settlement, UTF-16 growth, object identity, deep
iterative traversal, incremental parts, metadata replacement and all collector terminal paths.
Native probes verify concurrent large requests/results, complete hashes, zero accounting
after result handoff, cancelled waiting-body collectability and oversized-line cleanup.

The dense-value audit compares preserved compiled code with the revised code on the bundled
native Node runtime. Valid-fixture parse controls separate parsing/collection from accounting
cost; full hashes, exact numeric snapshots and dense request estimates match. Repeated small
parts, a dense tool and 1,000 events cover object density and burst delivery. Native observations
remain local controlled evidence and do not establish cross-platform or live-provider latency.

Fairness regressions cover one large input chunk, bursts of small chunks, cancellation, pending
end/close, upstream errors, idle timeout, CRLF/multibyte window boundaries and a source violating
pause. The existing fallback mock now uses a real Readable rather than an EventEmitter without
flow control, while preserving its result assertions. Native before/after fixtures compare
complete output hashes, FIFO promotion, abort/error/close/idle cleanup and input collectability.
A real loopback HTTP client disconnect exercises the production abort scope. A 64 MiB
unterminated input still rejects at the existing line budget and releases all numeric ownership.

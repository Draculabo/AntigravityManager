# Agent Note: Bounded cold restoration and maintenance continuation

Status: implemented

## Problem

Cold hydration overwrote responses captured during its read, and the first response after
restart suppressed durable hydration. Failed reads bypassed session-count eviction. Cold
worker replies decoded the full durable history before applying active request limits.
The cache bounded session count but could retain large strings across many sessions.
Audit age and row-limit maintenance could monopolize the worker through an entire backlog.
Dense Thought Store maintenance also blocked its worker through session cascade deletion.
Distinct-session cold bursts filled the worker's 25-command control lane and silently skipped
durable signature restoration. Concurrent management reads were rejected. Reusable close
also allowed a response capture to start a replacement writer while the old worker drained.

## Decision

Keep SQLite as the durable owner. Filter cold restore bodies from metadata using active
limits, merge pending captures on successful hydration, and retain captures on failed reads.
Apply count eviction on both branches and use an independent estimated 256 MiB cache budget.
Current requests retain their loaded records through restoration even if the cache evicts them.
Explicit management reads and durable schema/configuration formats remain unchanged.

Bound body expiry, summary age deletion, row-limit work and Thought Store age/capacity session
deletion per command. Validated worker replies report remaining work. Both stores use a shared,
diagnostics-owned scheduler justified by these two runtime consumers. The internal cleanup
reply changes from a count to validated progress; explicit deletion APIs remain unchanged.
The scheduler coalesces passes, retains hourly
maintenance and yields one second before successful backlog continuation. Stop/restart uses
a generation guard; failures log without immediate retry.

Cold loads have a Thought Store-owned admission boundary: one executing load, at most 64
waiting loads, and five seconds of waiting before an unissued load fails. FIFO execution yields
between replies, leaving worker control slots available to management. The count bounds retained
callbacks; the wait deadline bounds delay before execution without imposing a new SQLite timeout.
Admission failures retain captures and allow a later independent request, while executing-read
failures retain the existing no-retry policy. The service cancels waiting work on close/repair,
guards hydration by lifecycle generation, coalesces reusable close and blocks replacement work
until it completes. Shared worker priorities and durable/public stats formats are unchanged.

## Alternatives considered

- Load all bodies then prune: wastes decode/copy work and fails when excluded history is corrupt.
- Lower durable session limits: destroys history instead of managing cache pressure.
- Treat cache bytes as an RSS cap: ignores native allocations, transient copies and garbage.
- Drain all retention work in one command: blocks model writes and management reads.
- Retry failed maintenance immediately: can create repeated failure pressure without progress.
- Enlarge the shared worker control lane: increases large cold-reply exposure and management
  backlog instead of keeping cold admission with its domain owner.
- Force GC or claim an RSS cap: cannot control caller-held request bodies or all native allocations.

## Consequences

Evicted sessions require later SQLite reads. The cache weight is a conservative retained-string
estimate; transient memory can exceed it substantially. Different-session concurrent replies
and individual large SQLite transactions still have no hard memory/time deadline. Rejected
diagnostic persistence cannot be recovered merely by reloading an evicted cache entry.
Metadata selection assumes the repository's existing uncompressed byte accounting.
Backlog cleanup takes multiple passes and may temporarily exceed retention targets.
Cold bursts trade some total completion time for management responsiveness. Overload/deadline
failure can leave the current model request without recovered history, with diagnostic failure
accounting. Caller-held restored bodies remain live independently of cache eviction.

## Verification

Focused service tests cover concurrent hydration, capture races, failures, count and aggregate
eviction, uncacheable current-request restoration and configuration iteration. Scheduler tests
cover delayed continuation, coalescing, failure reporting and generation replacement.
Native worker tests cover bounded decode selection with unchanged durable history, corrupt
excluded bodies, expiry convergence, summary age/row limits and interleaved model writes.
Dense session cleanup measurements cover 2,000 sessions with 200 turns each. Native service
acceptance verifies configuration-driven continuation completes both stores' backlogs.
An isolated production service pressure run restores 48 synthetic 8 MiB sessions over three
cycles, including reload after eviction, configuration and shutdown. Measurement artifacts
record heap/RSS and latency separately; they do not establish days-long soak or live-provider behavior.
Native concurrent pressure additionally restores 48 distinct 8 MiB sessions, exercises eight
64 MiB sessions with and without admission in a timing-only harness, separates caller-retained
body memory, and checks terminal shutdown and reusable close/reopen during queued loads.

Current contracts are documented in [diagnostic retention](../../../../docs/modules/proxy-gateway/diagnostic-retention.md).

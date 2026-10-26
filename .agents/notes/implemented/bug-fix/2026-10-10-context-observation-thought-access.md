# Agent Note: Observe complete context and coalesce thought access writes

Status: implemented

## Problem

The gateway has output/thinking constraints and a compatibility model-list input limit,
but no reliable per-model input window. Measuring only incoming messages misses system
instructions, tools and restored signed history. Separately, 100 warm restores of an
unchanged thought history enqueue 100 SQLite access writes without saving new records.

## Decision

Observe semantic context at the internal Gemini generation boundary, after thought replay
and before explicit caching. At every physical send, retain this full estimate
beside an estimate of the current wire body and its exact serialized UTF-8 byte
length. This distinguishes moved cached prefixes from removed input and covers
regional/cache/recovery sends. Serialize once after attempt rebinding and use that
same string for unary and streamed HTTP bodies. Keep numerical diagnostics separate from provider usage.
Context estimation remains observational.

Transformation owners record closed kinds and positions in the existing request
context, bounded to 64 entries with a dropped count. They retain no original text,
signature or argument value. No global fallback state is created when there is no
request context. This is a partial refinement of observation; the thought access
coalescing and persistence obligations below remain unchanged.

Coalesce per-session access writes over a five-minute interval. Keep the
in-memory access clock current on every restore. Reuse accepted save/ingest operations
and completed hydration as access refreshes. Measure intervals with a monotonic clock;
keep state on the bounded memory session rather than introducing an independent map.
Do not suppress a subsequent access attempt after queue rejection or asynchronous failure.
Failure callbacks use marker identity so an old failure cannot invalidate newer work.

Current contracts and estimation limits are owned by
[the feature reference](../../../../docs/modules/proxy-gateway/inline-media-and-thought-history.md).

## Alternatives considered

- Rejecting against the fixed model-list value can reject valid provider requests.
- Compressing signed thought text changes the history contract and invalidates signatures.
- Serializing Base64 as prose inflates the estimate and adds unnecessary allocations.
- Persisting every restore creates disk traffic unrelated to new durable thought records.
- A trailing idle debounce can starve persistence for continuously active sessions.
- Dropping all access writes breaks durable idle retention.

## Consequences

No database schema, record codec, credentials or configuration format changes. Provider
usage and request history stay authoritative. Unknown media is explicitly unestimated.
The five-minute access interval introduces bounded durable timestamp lag, including after
normal shutdown. Near the idle
retention cutoff after restart, that lag can cause slightly earlier expiration. Queue
failures remain observable and can extend lag; failed record saves are not recovered by
an access refresh. Removing coalescing restores the previous per-restore write behavior.

## Verification

The red regression reports 100 `touch` writes for 100 unchanged restores. After the fix,
the same sequence enqueues none while restoring the complete thought and signature.
Focused tests cover interval boundaries, rejected queue admission, asynchronous failure,
stale callback ordering and complete context observation before cached-prefix removal.
Native acceptance uses an isolated standalone core, actual SQLite workers, synthetic
accounts and a loopback upstream. No client tool execution is needed.

The final focused suite passes 86 tests in 11 files; type checking, focused lint/format,
Agent contracts and the core build pass. Native acceptance passes 15 protocol scenarios,
100 signed-history restores with zero SQLite access updates and one retained thought
record, and a 640,004-character request with unchanged text. It observes 109 numerical
context diagnostics and shuts down successfully with no remaining temporary profile.

Initial native fixtures omitted the existing snake-case signature field and expected
trailing text whitespace to survive the mapper. Their expectations were corrected without
changing production contracts. Native logging then revealed that Nest debug output is
disabled by the gateway bootstrap. The diagnostic now uses the existing application
logger; the final rebuilt native check verifies its visibility.

The final focused suite passes 86 tests in 11 files; type checking, focused lint/format,
Agent contracts and the core build pass. Native acceptance passes 15 protocol scenarios,
100 signed-history restores with zero SQLite access updates and one retained thought
record, and a 640,004-character request with unchanged text. It observes 109 numerical
context diagnostics and shuts down successfully with no remaining temporary profile.

Initial native fixtures omitted the existing snake-case signature field and expected
trailing text whitespace to survive the mapper. Their expectations were corrected without
changing production contracts. Native logging then revealed that Nest debug output is
disabled by the gateway bootstrap. The diagnostic now uses the existing application
logger; the final rebuilt native check verifies its visibility.

Evidence is retained under `artifacts/protocol-context-thought-2026-10-10`. Live-provider,
packaging and cross-platform acceptance are not rerun for this batch. The running Electron
instance continues to use its previous build.

The D12 follow-up evidence (local artifact `d12-send-diagnostics-evidence.json` in the 2026-10-11 review collection)
adds actual loopback HTTP byte readback for unary/stream bodies, cache rejection,
regional failover, post-restoration estimates, cancellation/count exclusions,
metadata overflow and concurrent-request isolation. These source-runtime checks
do not repeat the earlier native build acceptance or establish provider token accuracy.

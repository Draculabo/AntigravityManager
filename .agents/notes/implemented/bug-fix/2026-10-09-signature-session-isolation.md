# Agent Note: conversation ownership for thought signatures

Status: implemented

## Problem

Issue #340 reports unrelated clients receiving another task's content. The supplied diagnostic
tail contains only legacy signature-cache accesses. A synthetic request-path reproduction
demonstrates that an unscoped signature from one task is injected into another task's unsigned
tool history. This establishes signature reuse across tasks, not HTTP response multiplexing
or the exact provider-generated answer reported by the user.

## Decision

The hot namespace has one 10,000-association ceiling across message, legacy and
tool-ID indexes, counting aliases and null ambiguity markers. A 500-session ceiling
alone left one session's message slots unbounded. Oldest captured associations are
evicted first, while the separate session LRU remains. Keep this retention policy
feature-owned instead of creating another mutable reverse registry.

Mapper cache values have no authoritative physical completion timestamp, so their
existing one-hour horizon becomes a fixed first-capture maximum. Reads, equivalent
updates and conflicts cannot renew it. Extending unknown provenance to seven days
or stamping a read as completion would fabricate lifetime evidence. Proven durable
Thought references keep their separate original-completion contract. A later capture
after expiry may establish a new association; eviction never replays a tool/model.

OpenAI Chat and Anthropic Messages derive signature ownership at the protocol service boundary.
The scope includes a digest of the presented proxy credential, a session hint and the initial
content anchor. Headers take precedence over query parameters and body metadata. Stable user
IDs are hints only. Account affinity may follow an explicit hint without the content anchor;
signature ownership cannot. Responses retains its response-ID lineage and durable format.

The in-memory store has no unscoped bucket. Historical tool recovery requires a matching
scoped tool-call ID, tool name and compatible effective model. A cache miss preserves explicit
request-local signatures and existing model-specific unsigned-tool handling. Generic latest-turn
or message-count signature fallback cannot establish tool ownership and is removed.

Tool entries additionally separate compatible physical-model families. Two independent
opaque values within one scoped tool ID invalidate automatic recovery, regardless of
length or message count. A different tool name under that ID is also ambiguous. The
cache retains a null marker, not an arbitrary candidate, until ordinary expiry, eviction
or explicit scope clearing. Recognized raw/wrapped forms of one Claude signature remain
equivalent and retain the first received bytes.

Session/message-count slots follow the same opaque-value conflict rule and are separated
by the normalized compatible model family, or exact physical model when no family is
registered. Rewind removes only future slots from the compatible source scope. When the
latest compatible slot is ambiguous, generic lookup returns a miss rather than an older
value. Message count is an index only, not causal ownership or a stream-fragment identity.

No credential, session hint or content is logged by scope resolution. Only fixed scope labels
and existing bounded counters enter signature-cache logs. This changes neither authentication
policy nor credential storage, database schemas or durable Responses state.

## Alternatives considered

- Keep a shared legacy bucket: rejected because absence of identity cannot establish ownership.
- Scope by user ID or TCP connection alone: rejected because clients can reuse IDs and connections
  across tasks, or open new connections within the same task.
- Generate a new scope for every request: rejected for ordinary conversations because it prevents
  signed tool continuation when a client omits signatures from its history.
- Recover any signature from the same session: rejected because the signature may belong to a
  different tool or historical branch.

## Consequences

The initial user content, system instructions and tool names must remain stable to recover a
cached signature. Context compaction or changing declarations can cause a safe miss. Identical
initial context under one proxy credential remains indistinguishable without separate session
hints. This is a deterministic fallback identity, not proof that two identical conversations are
the same conversation. Missing context cannot justify unscoped recovery.

Existing model provenance, bounded cache capacity, expiry and targeted recovery invalidation
remain in force. Restart clears this in-memory namespace. Native Gemini requests preserve their
own signed parts; this change adds no Gemini history reconstruction.
An ambiguous miss can leave a client without cached recovery. Request-local signatures
remain authoritative; the cache does not execute tools, concatenate opaque signatures
or introduce retries to repair a miss. Proving stream-fragment ownership requires a
separate response/part owner and remains a D04 obligation.

## Verification

The pre-fix synthetic probe fails both unscoped-store and outgoing-tool isolation assertions.
Focused tests cover absent IDs, reused IDs, tenant/header/query scope, appended turns, account
affinity, matching tool names and streaming/non-streaming OpenAI and Anthropic tool continuation.
Protocol mapper, controller, real service path, endpoint coverage and type checks are required.
Real-agent/provider acceptance is recorded separately in local ignored output; synthetic tests
alone do not establish provider acceptance or reproduce every reported answer.

Concurrent OpenCode and Claude Code runs with explicit identity hints removed return each
agent's exact controlled file contents, without the other task's marker. Provider audit records
confirm successful requests on the candidate gateway. One initial OpenCode preparation request
has cancellation/disconnection evidence and remains a recorded failed run; the focused pair
passes on resubmission with the same predicates. Test-owned cores stop and saved configurations
remain byte-for-byte unchanged.

Two concurrent Codex CLI sessions also complete Responses tool calls and result continuations,
returning their own exact file content with no foreign marker. All four requests ultimately
receive successful provider responses. These real-agent sessions are ephemeral; persisted
session restart and resume remain unverified.

The D04 cache ambiguity follow-up (local artifact `D04-signature-cache-ambiguity-implementation.md` in the 2026-10-11 review collection)
adds controlled regressions for reused IDs, distinct models, opaque conflicts, exact
wrapper equivalence, mapper preservation, expiry and clearing. It does not extend the
earlier live acceptance to the changed cache policy.

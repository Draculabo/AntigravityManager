# Agent Note: conversation ownership for thought signatures

Status: implemented

## Problem

Issue #340 reports unrelated clients receiving another task's content. The supplied diagnostic
tail contains only legacy signature-cache accesses. A synthetic request-path reproduction
demonstrates that an unscoped signature from one task is injected into another task's unsigned
tool history. This establishes signature reuse across tasks, not HTTP response multiplexing
or the exact provider-generated answer reported by the user.

## Decision

OpenAI Chat and Anthropic Messages derive signature ownership at the protocol service boundary.
The scope includes a digest of the presented proxy credential, a session hint and the initial
content anchor. Headers take precedence over query parameters and body metadata. Stable user
IDs are hints only. Account affinity may follow an explicit hint without the content anchor;
signature ownership cannot. Responses retains its response-ID lineage and durable format.

The in-memory store has no unscoped bucket. Historical tool recovery requires a matching
scoped tool-call ID, tool name and compatible effective model. A cache miss preserves explicit
request-local signatures and existing model-specific unsigned-tool handling. Generic latest-turn
or message-count signature fallback cannot establish tool ownership and is removed.

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

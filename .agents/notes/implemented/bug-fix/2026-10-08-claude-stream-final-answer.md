# Agent Note: Preserve Claude Code final answers with Gemini signatures

Status: implemented

## Problem

A real Claude Code 2.1.293 Read invocation through the gateway and Google Pro completes two
requests, but returns an empty final result. The controlled tool result reaches the upstream,
and the answer reaches the client's assistant text event. The mapper appends an empty thinking
signature carrier after that answer, so the CLI selects an empty last message. Some manually
emitted carrier starts also bypass active-block tracking and lose their corresponding stop.
The before/after records are in the local live evidence (`artifacts/schema-work-package/live-verification.md`).

## Decision

The Anthropic stream mapper emits signed-text carriers before visible text and opens them through
the existing block state machine so they terminate correctly. A later signature-only fragment
after visible text remains in the existing scoped SignatureStore instead of becoming a final
empty client message. A standalone signature without visible text keeps its carrier behavior.
The owning mapper retains this provider/protocol compatibility responsibility.

## Alternatives considered

- Accepting an earlier text event while the CLI's final result is empty would leave the user bug
  in place and weaken the live acceptance condition.
- Disabling thinking or discarding signatures could damage later tool turns and conceal the
  stream ordering problem.
- Buffering the complete answer to reorder a later signature would add latency and retention
  without a demonstrated need; the existing scoped store already receives every decoded signature.

## Consequences

Visible content remains the final client answer. Signature carriers now have matching stop
events. The existing in-memory signature retention bounds and lookup policy remain responsible
for signature-only fragments after text. Tool IDs, inputs, results, history recovery, durable
formats, account policies and quota behavior are unchanged.

## Verification

Three regression cases compare complete event sequences for attached, preceding and following
signatures and verify scoped signature retention. Streaming-state, malformed-input/timeout,
signature compatibility, tool-call leakage and real-path Anthropic/parity tests pass. The real
CLI rerun against `gemini-pro-agent` executes Read, returns its result and matches the final
answer. The separate Flash failure stays in the full acceptance result. See the
[current Schema and stream reference](../../../../docs/proxy-schema-conversion.md).

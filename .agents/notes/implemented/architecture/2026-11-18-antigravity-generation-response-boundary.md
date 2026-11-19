# Agent Note: Antigravity generation response boundary

Status: implemented
Date: 2026-11-18

## Problem

OpenAI Chat converted unary results through an Anthropic response object. Chat and Responses
independently read nested Google SSE fields before formatting their client events.

## Decision

Antigravity decodes unary generations and stream frames into typed results. Chat and Responses
project those results into their own events. Anthropic projects its unary result separately,
including client-specific signature encoding. The stream decoder yields parts on demand so
Responses can suspend serialization when its downstream writer applies backpressure.

## Alternatives considered

Direct Google-to-client decoders would duplicate usage and signature interpretation. Combining
the Chat and Responses stream lifecycles would mix their distinct completion, usage and event
ordering rules into one state machine.

## Consequences

The response decoders interpret Google parts and token metadata. Client adapters map validated
terminal reasons, decide when to emit finish and usage events, and keep their interruption behavior.
The execution services own account affinity, retry budgets and resource release.

## Verification

The [signature roundtrip fixtures](../../../../src/tests/unit/proxy-signature-roundtrip.test.ts)
exercise both unary and streaming continuation. The
[Responses backpressure fixtures](../../../../src/tests/unit/responses-lazy-frames.test.ts) and
[disconnect tests](../../../../src/tests/unit/openai-stream-disconnect-lifecycle.test.ts) exercise
event delivery and teardown under controlled upstream conditions.

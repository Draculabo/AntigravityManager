# Agent Note: Antigravity generation request boundary

Status: implemented
Date: 2026-11-18

## Problem

OpenAI Chat constructed a `ClaudeRequest` to send a Google generation request. The builder
read the caller's protocol from metadata to select sampling and stop defaults, and OpenAI schema
preparation inherited its types from the Claude request.

## Decision

The OpenAI and Anthropic adapters map their request fields and defaults into a shared
`AntigravityGenerationInput`. The schema preflight stays before account selection. The request
builder takes the resolved attempt values separately, including the project and model used to
restore signatures. Anthropic count and Claude-family warmup use the same Anthropic adapter.

## Alternatives considered

A direct OpenAI-to-Google mapper would duplicate content assembly, tool association, and
signature restoration. A gateway-wide protocol model would require agreement on response,
streaming, and provider capabilities beyond this request-building decision.

## Consequences

The generation input can change with the needs of the Antigravity builder. Client DTOs and
defaults remain owned by their respective adapters. Prepared schemas can be reused across attempts
while project and model selection are evaluated for the current attempt.

## Verification

The [Chat and Responses HTTP fixtures](../../../../src/tests/unit/chat-responses-compatibility-http.test.ts)
inspect outbound tools, paired results, and structured generation settings. The
[signature roundtrip tests](../../../../src/tests/unit/proxy-signature-roundtrip.test.ts) exercise
continuation through both protocol services. The focused retry, Responses WebSocket, Batch,
Anthropic count, and warmup suites cover additional consumers of the request path.

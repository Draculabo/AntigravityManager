# Agent Note: OpenAI Responses and Server Tool Compatibility

Status: implemented

The non-stream reasoning shape and camel-only tool configuration decisions below are superseded by [Responses Format Compatibility with Durable History](2026-08-30-responses-history-compatibility.md). The original verification below is historical evidence, not validation of the superseding behavior.

## Problem

Responses clients can omit `type` on role-bearing messages, send a terminal assistant text prefill, or begin a replacement transcript with stale tool history. The gateway previously dropped the first form and forwarded the latter forms in shapes the upstream model can reject. Non-stream Responses also discarded reasoning and preferred refusal over visible text. Separately, mapped Gemini requests did not opt into server-side tool invocation reporting.

## Decision

The Responses boundary parses unknown input once with Zod into a concrete discriminated union. A role-bearing item with no explicit type is normalized to `message`; unsupported shapes do not enter mapping logic. After continuation history is merged, the mapper removes the leading run of tool results and assistant tool calls after any system prefix, rewrites only a terminal assistant message with non-empty plain text and no tool calls to `user`, and restores an empty user message if cleanup empties the request.

Non-stream output preserves reasoning as the same commentary message form used by streaming output, preserves visible text and refusal as separate content parts, supplies empty output-text annotations, and emits a null top-level error. Streaming output uses the same annotated output-text shape.

Gemini tool configuration has a shared concrete type. Mapped Claude/OpenAI requests and direct Gemini passthrough requests set `includeServerSideToolInvocations: true` whenever tools are present, while preserving the caller's function-calling mode and allowed names. Only the canonical camelCase field is sent. Google Search remains mutually exclusive with function declarations.

## Alternatives considered

- Continue using `Record<string, unknown>` throughout mapping. Rejected because it permits misspelled variants and repeated ad-hoc narrowing after the runtime boundary.
- Emit reasoning items only for non-stream responses. Rejected because it would make the repository's stream and non-stream APIs disagree.
- Send camelCase and snake_case tool flags together. Rejected because aliases can be interpreted as duplicate protobuf fields.
- Remove any tool history found anywhere in a transcript. Rejected because only the leading run is invalid; later tool exchanges belong to an ordinary conversation.

## Consequences

Responses clients retain role-bearing messages and all response channels. A tool-only replacement transcript is intentionally discarded in the same way as the validated upstream implementation; clients must include an ordinary conversation message when the tool exchange is still relevant. Direct Gemini callers that provide tools now receive a default `VALIDATED` function-calling mode unless they supplied an explicit configuration.

## Verification

- `npm run test:unit -- --run src/tests/unit/proxy-controller.integration.test.ts`
- `npm run test:unit -- --run src/tests/unit/openai-responses-response-mapper.test.ts src/tests/unit/openai-responses-streaming-mapper.test.ts src/tests/unit/openai-responses-websocket-protocol.test.ts`
- `npm run test:unit -- --run src/tests/unit/claude-request-mapper-web-search.test.ts src/tests/unit/proxy-internal-request-mapping.test.ts`
- `npm run type-check`
- `npm run check:agent-contracts`

A live-provider probe on 2026-08-30 refreshed a discovered OAuth credential in memory, verified Google UserInfo, resolved the Code Assist project context, and submitted `includeServerSideToolInvocations: true` to `v1internal:generateContent`. The endpoint returned HTTP 403 for account-region eligibility rather than HTTP 400 request decoding, and did not identify `toolConfig` as invalid. This proves the request reaches the authenticated provider boundary, but it does not prove generation or server-side invocation behavior because eligibility gating occurred before a model response.

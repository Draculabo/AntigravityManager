# Agent Note: OpenAI buffered JSON fences

Status: implemented

## Problem

An upstream model can wrap valid JSON in Markdown despite a structured output request.
Buffered Responses already corrects this, but Chat Completions returned text a JSON
client could not parse.

## Decision

Share the existing Responses normalization with buffered Chat Completions. Apply it to
the finished choice before Chat storage so replay matches the original HTTP response.
Require a normal stop and a whole, parseable JSON payload inside the fence.

## Alternatives considered

- Stripping partial fences from streaming chunks can change the response before the final
  stop reason or JSON validity is known.
- Buffering streaming content to validate the whole result would delay deltas and increase
  memory use. Keep the existing streaming delivery contract.

## Consequences

Existing completion IDs still replay their saved objects. The [structured output reference](../../../../docs/modules/proxy-gateway/schema-conversion.md#openai-structured-output)
describes when a new reply is eligible for normalization.

## Verification

The [HTTP compatibility tests](../../../../src/tests/unit/chat-responses-compatibility-http.test.ts)
exercise Chat and Responses with fenced JSON, preserve streaming deltas and verify Chat replay.

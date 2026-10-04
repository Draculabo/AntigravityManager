# Agent Note: System Instruction Role Normalization

Status: implemented

## Problem

OpenAI Chat, Responses, Anthropic, and native Gemini adapters all produce internal Gemini requests, but their protocol-specific mappers either omit the system-instruction role or discard a caller-supplied native Gemini role. A shared final normalization to `user` keeps the upstream representation consistent across entry surfaces and avoids differences between cached and direct request bodies.

## Decision

`BaseProxyService.applyInternalGenerationConstraints` sets `body.request.systemInstruction.role` to `user` when a system instruction already exists, immediately before delegating to generation constraints and before the request reaches the Gemini client. `GeminiRequest.systemInstruction.role` is optional in the internal type because protocol mappers construct the pre-normalized shape. No mapper creates a system instruction merely to add the role.

The current compatibility contract is documented in [the proxy compatibility reference](../../../../docs/proxy-compatibility.md).

## Alternatives considered

- Normalize separately in the OpenAI, Anthropic, and native Gemini mappers: rejected because Responses shares OpenAI mapping while native Gemini would still need a separate implementation, allowing the four paths to drift.
- Normalize inside generation-config handling: rejected because requests without `generationConfig` can return early and still require the upstream role.
- Synthesize an empty system instruction for requests without one: rejected because that would change prompt semantics and the upstream request shape.

## Consequences

All generated upstream requests that already have a system instruction now carry `role: "user"`, including retry and project-context fallback attempts that re-enter the shared boundary. System instruction parts and the remaining request fields are not rewritten. Count-token requests retain their deliberate instruction omission. Protocol and image mappings that already remove a system instruction continue to do so; native Gemini image requests that carry one retain it and normalize its role to `"user"`. Explicit context-cache creation receives the same normalized representation as direct generation. No durable format, session migration, credential behavior, or new dependency is introduced.

## Verification

Focused real-path regressions cover OpenAI Chat, Responses, Anthropic Messages, and native Gemini unary and streaming requests. They assert that existing instructions reach the synthetic upstream with `role: "user"`, preserve instruction text, and do not synthesize a missing instruction. The focused run also includes the internal request mapping, cache-compatibility, and explicit-context-cache suites, plus TypeScript, formatting, Agent Note validation, and diff checks.

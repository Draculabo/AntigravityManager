# Agent Note: Recover unfinished unary thinking responses

Status: implemented

## Problem

A controlled real Pro tool request receives HTTP 200 with only thought content and no finish
reason. The gateway accepts nonempty parts and emits end_turn without a tool call or answer.
The anonymous before record preserves this shape without model text or account context.

## Decision

The owning shared generation path recognizes a nonempty candidate consisting entirely of
thought parts, without function/image output or a finish reason. It uses the existing single
stream-aggregation fallback with the same request and account. The same incomplete aggregate
throws a stable error instead of completing a unary answer. The common Gemini part contract
includes the provider's optional thought discriminator.

## Alternatives considered

- Treating any nonempty candidate as usable preserves false successful completion.
- Retrying every thought-only response would also replace explicit token limits and terminal
  tool-generation failures. Those existing protocol outcomes remain unchanged.
- Adding a separate retry loop would duplicate account policy and increase amplification.
  The current bounded fallback and outer retry policy own recovery.

## Consequences

Affected unary requests may perform one additional generation on the same account. Thought
fragments are replaced by the complete collected turn. Terminal provider reasons, prompt
blocks, account eligibility, quota filtering, tool-choice mapping and history policy remain
owned by their existing implementations. Actual malformed tool-generation responses are
distinct from missing-finish fragments and do not prove this recovery path.

## Verification

Regression tests fail before the change for fallback recovery and persistent incompleteness.
Real-path Anthropic, Gemini and parity coverage passes 50 tests, including an explicit token
limit. Type-check, focused ESLint and the core build pass. Live Pro acceptance injects the
disclosed incomplete shape, then obtains two actual tool calls from the real stream route and
both file results in all three continuation arrangements. Audit confirms exactly one unary
and one stream attempt on the same account for the initial request. The service restores its
stopped state and saved settings are unchanged. See the
[retry record](../../../../artifacts/schema-work-package/retry-verification.md).

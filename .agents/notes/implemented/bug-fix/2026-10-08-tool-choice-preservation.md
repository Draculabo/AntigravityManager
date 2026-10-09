# Agent Note: Preserve client tool selection through the gateway

Status: implemented

## Problem

A real Anthropic request explicitly selects a tool, but the upstream receives `VALIDATED`
and returns only thinking. The Anthropic service drops `tool_choice` when creating the internal
request. The common mapper also maps every object choice to `ANY`, losing `auto`, `none` and
named-tool restrictions. Five of ten new regression cases fail before the fix.

## Decision

The Anthropic boundary retains the existing typed choice. The owned `ToolChoiceCompat` module
maps both client representations to Gemini controls: auto/none use AUTO/NONE, required/any use
ANY, and named choices include allowedFunctionNames. An omitted choice retains VALIDATED.
The old mapper implementation is removed. The existing snake-case adapter remains responsible
for provider serialization.

## Alternatives considered

- Forcing ANY globally would alter requests that allow text answers or forbid tools.
- Rewriting adjacent history would address a different concern before acquiring a valid tool turn.
- Changing thinking or account routing would conceal the lost client instruction.

## Consequences

Explicit choices now reach the provider. Default selection, Schema admission, account/quota
policy, history repair and durable formats retain their existing contracts. This does not add
support for enforcing Anthropic's disable_parallel_tool_use option.

## Verification

Ten complete tool-control regressions include a controller/service/upstream path. Together with
Anthropic/parity coverage, 37 tests pass. The rebuilt prepared core receives two real parallel
calls and successfully continues combined, adjacent and reversed-result histories. The original
failure and passing run remain in the [live record](../../../../artifacts/schema-work-package/live-verification.md).
No history production change is needed for this witnessed case; retry history and other clients
remain separate coverage gaps.

# Agent Note: invalid thought signature recovery

Status: implemented

## Problem

Thought signatures are valid only for the upstream model family that produced them. Replaying a signature after account-level model rebinding, using a client-visible model as its origin, or trusting a provenance-less in-memory entry can produce a deterministic upstream HTTP 400. A generic provider rejection does not identify a safe history repair.

This decision is related to, but deliberately separate from, [proxy session and routing hardening](../../proposed/bug-fix/2026-08-26-proxy-session-and-routing-hardening.md).

## Decision

- Store normalized effective physical model provenance with every real upstream signature. Store the canonical registry family only when the producer also identifies the physical model to which that family resolution belongs. If request mapping later changes the physical model, discard the stale family hint and resolve compatibility from the model actually sent upstream.
- Require a target effective model for every cache read. Known families compare by canonical family; unknown models compare by exact normalized physical ID. Provenance-less entries are misses.
- Classify only upstream HTTP 400 errors with explicit thought-signature evidence. Broad deserialization, block-order and generic signature text does not qualify.
- Propagate a classified rejection without another send, account penalty, rotation or whole-scope cache invalidation. Retain the original failure and history; log only bounded model/source/stream classification.
- Keep proven wire-format conversion and exact scoped missing-signature lookup. Do not convert thinking to visible text, invent tool completion/interruption or append regeneration instructions. The old rewrite and recovery-mode mapper path are removed.
- Generation admission rejects missing tool results before account selection. Completed or failed results retain their real payloads. See [prompt identity boundaries](../architecture/2026-10-19-prompt-identity-boundaries.md) for generation-tail ownership.

## Alternatives considered

- Put the repair in the provider-neutral retry service: rejected because this is an Anthropic-to-Antigravity payload rewrite, not a network retry policy.
- Reuse signatures without provenance after restart: rejected because their origin cannot be established safely.
- Infer every non-Claude signature as Gemini-compatible: rejected because unknown providers and future model families would be silently cross-bound.
- Retry on broad deserialization or block-order messages: rejected because those errors can describe unrelated malformed payloads.
- Disable thinking or rewrite the model name during recovery: rejected because the original effective model and requested thinking behavior must remain stable.
- Guess a repaired history and retry once: rejected because a generic 400 does not identify a corrupt part; rewriting thinking or closing tools invents business state.

## Consequences

The signature store API uses options objects so provenance cannot be confused with session or message-count positional arguments. A family hint without a matching associated physical model is ignored. Response mappers need explicit upstream model context; synthetic responses without trustworthy provenance do not write signatures. Normal mapping retains scoped lookup and explicit client signatures. A provider rejection remains observable instead of becoming a semantically different second request.

The in-memory store remains short-lived and has no migration path. Old entries are intentionally ignored rather than assigned a guessed origin.

## Verification

Unit coverage exercises family and exact-model compatibility, physical-model remapping, legacy misses, LRU/session/tool-call isolation and narrow classifier positives and negatives. Unary/stream service checks preserve the original rejection, exact successful/failed/parallel results, cache scope and single dispatch. Missing results fail before leasing. See D12 evidence (local artifact `d12-generation-history-evidence.json` in the 2026-10-11 review collection). These controlled checks do not prove live-provider signature acceptance.

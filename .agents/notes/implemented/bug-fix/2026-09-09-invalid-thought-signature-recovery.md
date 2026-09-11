# Agent Note: invalid thought signature recovery

Status: implemented

## Problem

Thought signatures are valid only for the upstream model family that produced them. Replaying a signature after account-level model rebinding, using a client-visible model as its origin, or trusting a provenance-less in-memory entry can produce a deterministic upstream HTTP 400. The Anthropic compatibility path also needs a bounded way to repair already-corrupted thinking history without turning provider-specific payload recovery into generic network retry behavior.

This decision is related to, but deliberately separate from, [proxy session and routing hardening](../../proposed/bug-fix/2026-08-26-proxy-session-and-routing-hardening.md).

## Decision

- Store normalized effective physical model provenance with every real upstream signature. Store the canonical registry family only when the producer also identifies the physical model to which that family resolution belongs. If request mapping later changes the physical model, discard the stale family hint and resolve compatibility from the model actually sent upstream.
- Require a target effective model for every cache read. Known families compare by canonical family; unknown models compare by exact normalized physical ID. Provenance-less entries are misses.
- Keep recovery inside the Anthropic compatibility service. The shared proxy retry service is unchanged.
- Classify only upstream HTTP 400 errors with explicit thought-signature evidence. Broad deserialization, block-order and generic signature text does not qualify.
- Rebuild the retry from the original account-specific Claude request. Preserve non-empty thinking text as ordinary text, remove empty/redacted thinking, retain explicit tool-use signatures, and apply the fixed competitor-compatible tool-loop closures.
- Retry immediately once with the same account, token and effective physical model. Do not delay, penalize or rotate on the first classified error. Propagate a second classified error without another attempt.
- Permit stream recovery only before the upstream stream is returned. Never replay after client-visible events may have been emitted.

## Alternatives considered

- Put the repair in the provider-neutral retry service: rejected because this is an Anthropic-to-Antigravity payload rewrite, not a network retry policy.
- Reuse signatures without provenance after restart: rejected because their origin cannot be established safely.
- Infer every non-Claude signature as Gemini-compatible: rejected because unknown providers and future model families would be silently cross-bound.
- Retry on broad deserialization or block-order messages: rejected because those errors can describe unrelated malformed payloads.
- Disable thinking or rewrite the model name during recovery: rejected because the original effective model and requested thinking behavior must remain stable.
- Wait before the repair attempt: rejected because the failure is deterministic and has no backoff semantics.

## Consequences

The signature store API uses options objects so provenance cannot be confused with session or message-count positional arguments. A family hint without a matching associated physical model is ignored. Response mappers need explicit upstream model context; synthetic responses without trustworthy provenance do not write signatures. Recovery-mode request mapping bypasses all cache getters while preserving explicit client tool signatures and the existing compatibility sentinel.

The in-memory store remains short-lived and has no migration path. Old entries are intentionally ignored rather than assigned a guessed origin.

## Verification

Unit coverage exercises family and exact-model compatibility, physical-model remapping, legacy misses, LRU/session/tool-call isolation, narrow classifier positives and negatives, exact history rewrites, recovery-mode cache bypass, same-account one-shot recovery, and the real Anthropic and OpenAI-compatible service paths. Type and boundary checks remain part of the change gate. Live-provider recovery is supplemental and was not required for this deterministic compatibility decision.

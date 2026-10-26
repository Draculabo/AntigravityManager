# Agent Note: Stop generating placeholder thought signatures

Status: implemented

Scope: D04 R7 automatic-generation removal; explicit-client placeholder admission remains open.

## Problem

Native Gemini Flash envelopes, Claude tool-history mapping and Thought Store restoration
could generate `skip_thought_signature_validator` when no real signature existed.
SignatureStore also accepted that placeholder as a recoverable provider signature.
This made an absent signature appear supplied and hid a cache miss behind a fabricated value.

## Decision

Missing signatures remain absent after existing scoped recovery. Native Gemini only completes
aliases of values actually supplied by the caller. Claude mapping retains its missing-signature
warning and does not generate a fallback in normal or recovery mode. Thought Store can restore
unsigned reasoning without attaching an invented signature to reasoning or function calls.

SignatureStore refuses the known placeholder on admission, both for session and tool indexes.
Existing caller-supplied values remain protocol input under current mapping behavior; the
model-specific placeholder gate and conflicting aliases belong to the separate format/source
slice. This change neither treats those values as authentic nor certifies upstream acceptance.

## Alternatives considered

- Retaining the old Flash default would continue generating signatures automatically and violate the D04 contract.
- Dropping the whole unsigned tool history would lose caller history and change tool association.
- Inventing local success text or executing tools to repair a model request would mask failure
  and could repeat side effects.

## Consequences

Clients relying on automatic placeholders can now receive the provider's missing-signature
failure. They need to preserve actual signatures or supply genuine history from their client.
No new retry, local tool execution, database migration or encryption is introduced. Obsolete
placeholder-generation counters are removed; they have no production consumers.

The upgrade action and rollback limits are in the
[upgrade guide](../../../../docs/upgrade-guides/next/preserve-tool-signatures.md).

## Verification

Focused fixtures cover native and Claude unsigned history, preserved explicit signatures,
recovery mode, placeholder cache rejection and unsigned Thought Store restoration. Gemini
unary and streaming execution are checked through the existing synthetic real-path harness.
That harness uses fixture upstream responses, not live providers. Final evidence is recorded
in the D04 implementation report (local artifact `D04-no-auto-sentinel-implementation.md` in the 2026-10-11 review collection).

# Agent Note: Recover supplemental reasoning usage from Gemini modality details

Status: implemented

## Problem

An upstream response can report reasoning only in `candidatesTokensDetails`. OpenAI usage
mapping and the independent Anthropic mappers read scalar counters only, while the
Responses streamed adapter discards the array. Clients consequently miss reasoning
statistics even though their input/output totals are present.

## Decision

Use one provider-owned reasoning resolver across the three compatibility surfaces. Preserve
the existing scalar precedence, including zero, and use modality details only when those
scalars are absent. Narrow the new nested field because SSE validates only its envelope.
Responses carries normalized details into its usage mapper. Preserve each protocol's
existing output accounting and default stream placement.

The current contract is documented in [the protocol reference](../../../../docs/modules/proxy-gateway/stream-tool-compatibility.md#reasoning-usage-metadata).

## Alternatives considered

- Modality-first precedence would change established output when the two representations disagree.
- Adding detail counts to legacy candidate totals would double-count reasoning.
- Updating the OpenAI helper alone would leave Responses streaming and Anthropic inconsistent.
- Scaling displayed usage would introduce a separate billing policy without evidence.

## Consequences

Previously missing reasoning details become visible. No durable format, account selection,
retry, usage placement or native Gemini passthrough policy changes. Malformed modality entries
do not affect supplemental statistics. Scalar validation remains with the existing boundary.
Anthropic's public unary response retains its established usage projection without a
reasoning field; internal unary mapping supplies Chat/Responses conversions, while the
existing Anthropic SSE reasoning extension uses the fallback. No new public Anthropic
field is introduced.

## Verification

Focused mapper and real-path tests cover fallback, explicit scalar precedence, explicit zero,
legacy and Interactions accounting, malformed nested entries and streaming placement.
The acceptance checks covered isolated native HTTP/SSE. Live-provider and packaged Electron
behavior require separate evidence.

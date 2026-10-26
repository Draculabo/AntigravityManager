# Agent Note: Thought signature part ownership

Status: implemented

Scope: D04 message-local fallback, unsigned mapped tool results, signed-history text and preservation of supplied parallel signatures.

## Problem

Claude request mapping carries a thinking signature across message boundaries
and copies it to tool results. Thought Store restoration can also replace
independent parallel function-call signatures with one record-level signature,
including when only placeholder reasoning needs repair.

## Decision

The mapper's fallback from an explicit thinking block is local to its current
message. Explicit tool-use signatures and scoped tool-cache recovery retain
their existing priority. Mapped function responses contain their tool identity
and result without an invented model signature, in both normal and recovery modes.

Thought Store restoration preserves every supplied nonempty, non-placeholder
function-call signature, including short opaque values and either supported
alias. It does not add a conflicting camel-case alias beside an existing
snake-case signature. Reasoning restoration still follows the matched record.
This is preservation of a supplied value, not format or provider validation.

An assistant message carrying a nonempty thinking or tool-use signature preserves every
text block as supplied. The request mapper does not trim it, remove blank/placeholder
text or reinterpret inline-image Markdown. Media admission uses the same predicate before
normalization, so it does not rewrite literal Markdown MIME declarations in that text.
Actual media blocks retain their admission and byte/count limits. Unsigned messages retain
their existing normalization. The predicate does not infer cryptographic validity from
presence or length.

## Alternatives considered

- Carry the last signature across all messages: rejected because a later
  assistant turn has no evidence that it owns that earlier signature.
- Put the signature on tool results: rejected because a tool result is not
  the model's signed function-call output.
- Replace every parallel signature with the record signature: rejected because
  a turn-level value cannot override an independent supplied tool signature.
- Change the persistent record shape now: deferred to the full per-tool/round
  association work; this slice needs no format migration.

## Consequences

A later unsigned tool call can now reach the existing missing-signature path
when scoped recovery does not find it. No placeholder, execution or new retry
is added. Existing client-supplied values remain opaque.

This slice preserves the request-mapping and signed-history rules independently
from persistence. Per-tool historical capture and recovery are now implemented
in the [dedicated persistence decision](2026-10-18-thought-part-signature-persistence.md).
Native caller-supplied tool-result fields are not normalized by this mapper change.

## Verification

Regression tests compare complete mapped tool results in normal and recovery
modes, verify that a later unsigned call cannot borrow an earlier message's
signature, retain valid same-message fallback and compare restored parallel
calls for both aliases and short opaque values.

Signed-history preservation first reproduced 16 failures across normal and recovery
mapping. The five-file focused selection then passed 80 tests, including exact whitespace,
literal placeholder text, inline-image Markdown, thinking/tool-use signature sources,
caller-object immutability and existing unsigned normalization. A production service path
retains signed literal text while invalid actual media still fails admission. One existing
nested-media fixture lacked the preceding tool call required by the earlier association
change; it now supplies a complete exchange and retains full-byte media assertions.

Owning mapper, store, signature recovery and synthetic HTTP protocol tests
exercise the combined change. Live provider and installed client acceptance
remain deferred. See the
[upgrade guide](../../../../docs/upgrade-guides/next/preserve-tool-signatures.md).

# Agent Note: bounded known thought signature conversion

Status: implemented

This implements D04 R5 format conversion and generation request/response alias guards,
plus the follow-up target-model gate for recognized signature families. Other D04 obligations
remain pending.

## Problem

Claude client signatures and Google's bytes-backed signature field can carry the same
payload through different Base64 layers. Exact byte comparison fails to associate known
raw/wrapped forms, while wrapping every value repeatedly grows signatures and corrupts
unknown encodings. The earlier
[opaque signature decision](2026-10-13-opaque-thought-signatures.md) still forbids generic
Base64-to-text inference, particularly for Gemini binary protobuf values.

## Decision

An adapter-owned format helper recognizes canonical standard Base64 with either the
case-insensitive Claude marker in decoded bytes or the known `08 04 12` protobuf prefix.
A Google wrapper is recognized only when its decoded ASCII inner value is itself
canonical Base64 with that recognized payload. The `CAQS` text prefix alone is insufficient.
Detection is structural, not cryptographic validation.

Google internal generation prepares a shallow copy after Thought Store ingestion and
restoration and before context-cache preparation or HTTP serialization. Recognized
raw Claude values gain one wrapper; already wrapped and unknown values are unchanged.
Only changed contents and parts are copied; unchanged parts retain their references.
The caller's history and captured original values are not normalized in place.

Anthropic unary and stream mapping removes only the recognized Google wrapper for
client output. Session and per-tool caches receive the original upstream value.
Non-streaming OpenAI mapping that reuses the Anthropic adapter inherits that conversion;
other OpenAI response adapters keep their existing opaque output contract. The Google-bound
request conversion recognizes either representation regardless of that client path.

Thought Store matching, conflict checks and explicit-signature restoration compare the
separate raw form for recognized Claude values. Storage retains received originals.
Recorded-model compatibility, one-record consumption and signed-turn ownership remain
required; format equivalence cannot authorize cross-model restoration.

Unknown values, placeholders, whitespace, malformed/noncanonical Base64 and additional
wrappers are preserved exactly. Classification performs at most two decode layers,
with a 1 MiB encoded-input recognition budget; larger values remain opaque. Both
aliases are mapped independently after the generation request guard verifies equality or
recognized raw/wrapped equivalence. Missing aliases and equal empty values are allowed;
empty versus nonempty is a conflict. Native Gemini rejects conflicts before account
selection, and direct public/internal generation and warmup reject before history ingestion,
attempt auditing or HTTP. The typed 400 identifies only the content and part position.
The separate target gate classifies recognized Claude and Gemini signatures against the
routed model's registered family before history preparation. Cross-family signatures fail
with a position-only 400; recognized signatures also fail closed when the target family is
unknown. The observed Gemini placeholder remains eligible for Gemini targets. Claude targets reject it. Unknown opaque formats are retained unchanged and are not
declared compatible by inference. Format recognition remains structural, not cryptographic.
Product generation also checks original upstream response aliases before capture or mapping.
A conflict becomes a safe typed 502 that bypasses endpoint failover, protocol fallbacks and
account rotation. Equivalent aliases and originals remain unchanged. The position is retained;
the error contains no signature material.

Streaming uses the existing bounded audit parser to inspect the original JSON tree before
sanitization, then releases original frame segments only after the whole event passes.
This prevents a complete data line from reaching a mapper while its separating blank line
is still in flight. Segment references avoid a second whole-frame concatenation; no additional
JSON parse or serialization is introduced. Audit observers still receive sanitized values.
The parser's existing cap also bounds validation; over-budget events fail the generation
stream and close the source. Final events without a delimiter are checked during flush.
Ordinary audit-only use retains its existing behavior; raw diagnostic forwarding and
countTokens remain outside generation response validation. Warmup still acknowledges HTTP
status without consuming model output.

The exact canonical Base64 encoding of the legacy Gemini placeholder is also
recognized. Both forms follow the same model gate and are absent from recoverable
signature material. The Thought Store decodes an older saved placeholder to null
and keeps its part layout. The change does not rewrite existing database rows.

The native Gemini gateway projects an outbound Claude continuation only when an explicit
Claude selection and the routed Claude target follow a successful Gemini generation under
the same credential and anchored session. The bounded in-memory observation lasts ten
minutes and is discarded on gateway restart. The projection omits recognized Gemini
signatures and placeholders from model parts and drops the private thought-only parts that
carry them. A recognized Gemini signature also scopes the removal of unsigned private
thought-only parts to the same model turn. Real Gemini replies can sign the tool call and
leave the preceding thought unsigned. Claude rejected that mixed history even after
signature removal. The projection retains visible content and tool exchanges.
Unproven switches still use the position-only target gate. A shared API key by itself
cannot authorize the projection.

## Alternatives considered

- Decode printable Base64 to text: rejected because ASCII protobuf data is binary.
- Repeatedly unwrap or wrap any Base64 value: rejected because it guesses encoding and
  permits amplification. The direction belongs to the boundary.
- Canonicalize database values: rejected because matching does not require a migration
  and original provider material must remain available for diagnosis.
- Infer cryptographic validity from recognized format: rejected. The model gate prevents
  known cross-family reuse but cannot prove that Google accepts a signature.

## Consequences

No durable shape, credential, encryption or database-schema change is introduced.
Code rollback remains possible with the same stored format, but older exact-only matching
may fail to associate the equivalent forms. Missing or previously corrupted signature
material cannot be reconstructed. No new retry or tool execution is added.
Raw diagnostic passthrough and countTokens are outside internal generation conversion.
Installed-client behavior remains open.

## Verification

Focused and expanded protocol tests check canonical raw/wrapped conversion, idempotence,
unknown/Gemini preservation, alias preservation, caller immutability, client output,
original session/tool cache values, restoration and serialized unary/stream bodies.
The follow-up target-model gate report (local artifact `D04-target-model-gate-implementation.md` in the 2026-10-11 review collection)
records cross-family rejection, explicit-placeholder policy, unknown opaque pass-through and
the before-account-selection execution path.
Production Thought Store worker tests use isolated native SQLite files to check save,
historical ingestion, preserved values, restart and idempotence. The implementation
report (local artifact `D04-known-format-implementation.md` in the 2026-10-11 review collection)
records commands, failures, final counts and evidence limits.
The request guard report (local artifact `D04-request-alias-implementation.md` in the 2026-10-11 review collection)
records failing controller/transport baselines, safe rejection and equivalent-pair coverage.
The response guard report (local artifact `D04-response-alias-implementation.md` in the 2026-10-11 review collection)
records fragmented-event isolation, safe terminal errors, parser bounds and protocol evidence.
The model switch checks exercise unary and streaming continuations over loopback HTTP, including
the original 400 when projection is disabled. A real Gemini-to-Claude replay through the
standalone Core confirms that mixed signed tool history and unsigned thought can continue
with the expected tool result. The installed Antigravity client flow remains open.

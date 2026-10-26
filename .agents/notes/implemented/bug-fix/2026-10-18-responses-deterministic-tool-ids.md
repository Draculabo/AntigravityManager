# Agent Note: deterministic missing tool-call IDs

Status: implemented

## Problem

Responses assigned `call_<timestamp>` to calls missing an ID. Replaying one history later
changed its ID, while parallel calls in the same millisecond collided. OpenAI Chat used a
random fallback for a missing result ID, and native Gemini forwarded optional function
call and result IDs without resolving their association. These paths could lose a tool
round during replay or silently connect a result to the wrong call.

## Decision

Each protocol adapter owns a chronological normalization pass over its effective history.
Responses processes the complete reconstructed input; OpenAI Chat processes messages and
Gemini processes native contents. Only missing call IDs are filled. The adapter hashes the
causal history, normalized tool name, canonical arguments and call position with the
existing framed, key-order-stable session hasher. This distinguishes identical parallel
calls and keeps a complete replay stable. Generated IDs use `call_` plus 128 bits of a
digest; prompts, arguments and credentials are not embedded in the ID. Supplied IDs and
caller-owned input objects remain unchanged.

An output missing its ID binds only to the single preceding pending call; zero or multiple
candidates fail with a position-only HTTP 400. Tool names, array order and cached order
never resolve ambiguity. Completed IDs may be reused in a later round, and final pending
calls remain valid. OpenAI Chat and Gemini perform this validation before account selection;
invalid history causes no upstream dispatch, account penalty or retry. The mapper also
checks Chat history when called directly.

Responses writes generated IDs into the retained input delta before media sanitization.
Parent reconstruction happens before association, so a result-only continuation reuses its
call's existing identity. Fully identified histories skip hashing message and media content.
No global identity cache is introduced.

The input-item codec is separate from request mapping and identity normalization. It keeps
the same accepted shapes without a circular dependency or compatibility re-export.

## Alternatives considered

- Timestamp or random IDs: rejected because history replay changes identity.
- Tool name and argument digest only: rejected because identical calls can coexist.
- Leading/trailing text samples: rejected because equal-length middle edits can collide.
- Assign IDs only while emitting chat messages: rejected because retained input loses them.
- Choose a missing-ID result by tool name, array order or cache order: rejected because that
  guesses intent.

## Consequences

This implements missing call-ID association for Responses, OpenAI Chat, native Gemini and
Gemini-to-Claude/Chat/Responses responses. Response-side adapters use one invocation-local
identity object created by the owning service. It lazily hashes the full effective prompt
history, model and tool declarations once, then combines that digest with each response call's position, original name and
canonical arguments. Unary Claude mapping, Claude streaming, OpenAI Chat streaming,
Responses streaming and unary-to-stream fallbacks share that request-scoped identity.
Direct mapper callers without a service scope use only the model/session or response context
provided to that mapper.

A digest identifies the history actually supplied; it cannot recover causal evidence removed
by compaction or prove a provider signature valid. D04 R2/R9 signature-cache turn identity
and the rest of D04 remain separate obligations.

Existing protocol fields carry the generated value. No database schema, file version,
credential handling or encryption changes. There is no migration of the user's real files.
Input without enough result-association evidence now fails explicitly; the [upgrade
guide](../../../../docs/upgrade-guides/next/retain-tool-call-history.md) describes recovery
without repeating tools.

## Verification

The Responses implementation first reproduced eight failures in nine fixed-clock
regressions. Its combined controlled selection passed 30 files / 374 tests, including an
isolated file flush/restart with sanitized media, stable endpoint IDs and existing
WebSocket, store, lineage and protocol paths. The OpenAI Chat and Gemini implementation
passed its six-file protocol selection with 105 tests, including real-path HTTP/controller
coverage, deterministic replay, parallel calls, unique-result inference, ambiguous-result
rejection and pre-account-selection checks. Response-side deterministic IDs were reproduced
as five failing behavioral assertions before the implementation; another fixture required
the correct signature source context. The resulting controlled
selection passed 6 files / 132 tests across Claude unary/stream, Chat, Responses and
synthetic fallback paths, including same-request replay, long-history middle edits,
parallel identical calls, argument key-order canonicalization, name/argument changes,
explicit-ID preservation and signature association. Type checking and focused ESLint pass.

The Responses implementation report (local artifact `D04-responses-tool-id-implementation.md` in the 2026-10-11 review collection)
and Chat/Gemini implementation report (local artifact `D04-chat-gemini-tool-id-implementation.md` in the 2026-10-11 review collection)
record executable evidence. Real provider, installed-client and real-profile acceptance
remain deferred.

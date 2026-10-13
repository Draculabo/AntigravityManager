# Agent Note: opaque thought signature encoding

Status: implemented

## Problem

Issue #347 reports Google rejecting continuation requests because a Base64-encoded binary thought
signature becomes raw text. The former `decodeSignature` function treated a successful UTF-8
round trip as evidence that the signature was text. Protobuf field tags followed by an ASCII UUID
satisfy that heuristic, so response adapters cached and replayed control characters in a bytes
field. The same behavior was introduced by `5772e2e9` on 2026-01-16; the helper remained unchanged
through 0.25.1. Existing unit tests explicitly expected text decoding and missed this defect.

## Decision

The owning signature helper is renamed `readThoughtSignature` and returns every non-empty string
unchanged. Anthropic response/stream adapters, OpenAI Chat streaming and Responses streaming use
that contract. Non-streaming OpenAI paths reuse the Anthropic response adapter. The old decoding
implementation is removed without a compatibility export.

No format inference, automatic Base64 re-encoding or signature validation is added. The provider
owns the opaque value and its model-specific validation. Existing scoped ownership, model
provenance, placeholder handling and narrow invalid-signature recovery remain in force.

## Alternatives considered

- Decode only printable UTF-8: rejected because printable content does not distinguish binary
  signature bytes from encoded text.
- Re-encode every string that fails a Base64 regex: rejected because provider-specific opaque
  strings and validation placeholders are not necessarily Base64, and guessing an old encoding
  can modify a valid token or lose its bytes.
- Rewrite persisted history: rejected because this fix has no authoritative original bytes for
  previously transformed data and requires no durable-format migration.

## Consequences

New response signatures remain encoded through client output, scoped caches and subsequent
requests. Clients must treat returned signatures as opaque. Restart clears the in-memory cache,
but does not repair a client-supplied poisoned history or a persisted record. Existing supported
400 recovery can omit invalid signatures for its single targeted attempt; this change does not
add that recovery to other protocols or guarantee recovery of every old session.

## Verification

The pre-fix helper reproduction turns synthetic protobuf bytes `12 26 0a 24` plus an ASCII UUID
into raw control-character text. Production Anthropic and OpenAI Chat services replay the same
corrupted value for streaming and non-streaming tool continuations. The reproduction fails on
both Node 22.17.1 and Node 24.15.0.

Before the production edit, the checked-in preservation regressions fail six assertions:
ASCII protobuf and printable-text Base64 preservation, plus all four tool-continuation paths.
Afterward, the first focused run passes all 74 utility, round-trip, isolation, Responses mapper
and recovery tests. The round-trip suite also covers Responses parent-response continuations.
The wider run covers 21 suites and 265 tests; its only initial failure is an older retry fixture
that expected decoded signature text. Updating that assertion to compare the original encoding
retains its ordering, deduplication and finish checks; all 49 retry tests pass on rerun. The other
216 tests pass in the wider run. Node 22.17.1 also passes all 16 utility and six-path continuation
tests. Type checking, focused ESLint/formatting and Agent Contracts pass.
The regression harness substitutes external account leases and upstream responses; it uses
synthetic data and does not establish an actual Google HTTP 400.

Live acceptance on Windows x64 also exercises the freshly built standalone core with real
Google responses from `gemini-3.8-flash-tiered`, confirmed by a fresh isolated quota lookup.
Claude Code 2.1.293 completes its read-only probe in five upstream requests; OpenCode 1.18.33
completes it in four. All requests return HTTP 200. Their subsequent requests contain exact
copies of the observed upstream signatures, with no unknown signatures or invalid Base64.
Codex 0.158.0 completes its fixed-file MCP probe in two successful requests, but this inline
continuation does not replay an observed non-placeholder signature; its functional success is
not evidence of exact signature replay. A separate Responses `previous_response_id` tool
continuation replays the observed signature unchanged and receives HTTP 200.

The live signatures do not satisfy the former UTF-8 decoding heuristic, so this run verifies
provider compatibility and does not reproduce the reporter's particular binary encoding.
The checked-in synthetic protobuf regressions establish that encoding case. Live testing uses
temporary SQLite backups and profiles, records only bounded anonymous summaries, and removes
the temporary profiles and credentials after stopping the owned core. Original settings and
account database hashes remain unchanged. This evidence covers the tested Windows runtime and
model; it does not establish other platforms, every model or repair of previously poisoned
client histories.

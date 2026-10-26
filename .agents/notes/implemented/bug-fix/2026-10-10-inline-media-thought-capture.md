# Agent Note: Reject invalid inline media and skip unsigned thought placeholders

Status: implemented

## Problem

Ordinary Chat and Anthropic paths could pass empty or malformed Base64 to the provider,
or convert a malformed image data URL into text. These paths did not consistently reuse
the image limits and MIME sniffing already available for images and file uploads.
Thought capture also submitted storage writes for unsigned placeholder text, despite
classifying that text as nonmeaningful later in the storage pipeline.

## Decision

Normalize and validate inline media in an owned gateway admission module before leasing.
Reuse existing image limits, file MIME detection and M4A container recognition. Preserve
bytes, correct recognized MIME within a media family and reject cross-family content
with a diagnosable HTTP 400. Share the Markdown image grammar with the request mapper.

Require meaningful thought text or a real signature for captured thought records. Keep
signature-only records and existing restoration behavior. Retain the model generation
policy; signature preservation and disabling a server-authoritative budget are different
contracts. Current behavior is described in
[the feature reference](../../../../docs/modules/proxy-gateway/inline-media-and-thought-history.md).

## Alternatives considered

- Replacing malformed media with text would silently change user input.
- Provider-side rejection would consume an account lease and could trigger retries.
- Rejecting all unknown binary signatures would exclude formats outside the existing sniffer.
- Removing every placeholder would discard real signatures needed for tool continuation.
- Overriding the registered thinking budget would change an independent model-policy contract.

## Consequences

Clients sending malformed media or unsupported cross-family declarations receive an
earlier HTTP 400. Request-wide image limits also cover nested and Markdown images.
Admission returns a normalized request without mutating the caller's request.
No database schema or durable record format changes. Previously stored placeholders are
not deleted. Full media decoding remains the provider's responsibility.

## Verification

The initial production-path regression rejected none of six invalid media fixtures.
The initial capture regression submitted a save for each of four unsigned placeholders.
Both regressions pass after the fix. Mapper tests preserve signed tool history with
generation disabled and restore a sentinel to a real signature without changing arguments.
The final focused run passes 168 tests in 14 files. TypeScript, focused ESLint/Prettier,
Agent contracts, the core build and Git whitespace checks pass.

Native isolated acceptance covers 15 HTTP/SSE scenarios, real SQLite thought capture,
zero upstream attempts for invalid input and one attempt for admitted generation.
The first runtime script incorrectly classified token counting as model traffic and
expected a registered model profile to honor a client disable flag. Its results are
retained; corrected assertions follow the existing auxiliary audit and generation policies.

Three live-provider requests pass: Chat PNG input declared as JPEG with independent usage,
Anthropic image input producing a signed tool response, and continuation with that signed
history and a synthetic tool result. Each has one upstream attempt. No tool is executed;
the original configuration is unchanged and the temporary credential copy is removed.
Reports are under `artifacts/protocol-media-thinking-2026-10-10`. The final whitespace,
case normalization and prose-position adjustments are additionally covered by deterministic
and native checks.
The running Electron instance is not rebuilt or restarted by this change; native acceptance
uses the independently built core. Packaging and cross-platform acceptance are not run.

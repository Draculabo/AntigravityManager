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

Explicit image slots additionally require recognized image signatures and minimum container
completeness across Chat, Responses, Messages, Gemini and image generation/editing. Unknown
image bytes and truncated containers cannot rely on their declared MIME. Keep this policy
separate from generic file uploads and other media families. Invalid tool-text image candidates
remain text. Image decoding and cryptographic integrity are outside this admission contract.

Content-store operations share one pending cold-index initialization. The original eager
`loaded` flag let a second read observe an empty map during filesystem initialization,
causing concurrent restored Responses requests to report retained media as missing. A failed
initialization releases its promise so an explicit later operation can retry.

The opt-in send window has an explicit default-count strategy. Count and decoded-file
memory are separate policies, with all current images protected and remote bytes never
estimated from URLs. Settings exposes the existing owner through partial updates that
preserve image scheduler concurrency. Configuration without the new strategy resolves
to count; the earlier controlled combined-budget behavior is replaced as required by
the confirmed D07 policy. See the [upgrade guide](../../../../docs/upgrade-guides/next/strict-inline-images.md).

Require meaningful thought text or a real signature for captured thought records. Keep
signature-only records and existing restoration behavior. Retain the model generation
policy; signature preservation and disabling a server-authoritative budget are different
contracts. Current behavior is described in
[the feature reference](../../../../docs/modules/proxy-gateway/inline-media-and-thought-history.md).

Responses also privately externalizes image-bearing tool text recognized by that same
extraction policy. A version-2 `json-text` reference retains exact original spelling via
JSON string encoding, rather than persisting the send-view placeholder. Up to four
16 MiB chunks fit the existing 20 MiB private-file ceiling; total serialized text is
limited to 64 MiB and consumes the existing 512 MiB/48-hour namespace policy. The
reference carries bounded chunk IDs, complete byte count and SHA-256. Restore validates
the record, chunk sizes, digest and decoded string before handing it to request mapping.
Arguments, metadata, invalid candidates, fenced examples and ordinary logs are unchanged.
Private writes complete before the existing strict session flush. Partial writes have
no published session reference and expire under the existing bounded private-store policy.
New client input is checked for internal references before restoring merged history, so a
supplied private reference cannot bypass history ownership. The internal restore path
continues to require the saved response's owner. Wrapped image URL references restore
inside their URL object without losing detail metadata.

## Alternatives considered

- Replacing malformed media with text would silently change user input.
- Provider-side rejection would consume an account lease and could trigger retries.
- Rejecting unknown signatures for every media family would exclude formats outside the
  existing sniffer. The stricter rule applies to explicit images only.
- Removing every placeholder would discard real signatures needed for tool continuation.
- Overriding the registered thinking budget would change an independent model-policy contract.
- Persisting extracted tool images as rewritten protocol blocks would lose exact original
  text and change replay comparisons. A private original-text reference preserves those
  semantics. Storing the whole text as one private file would reject a valid 20 MiB image
  whose Base64 representation exceeds that file ceiling; bounded chunks avoid that mismatch.

## Consequences

Clients sending malformed media or unsupported cross-family declarations receive an
earlier HTTP 400. Request-wide image limits also cover nested and Markdown images.
Admission returns a normalized request without mutating the caller's request.
The database schema and version-1 image/audio references are unchanged. New image-bearing
tool outputs use version-2 private references. Older versions cannot resume those newly
written histories; see the [tool-media upgrade guide](../../../../docs/upgrade-guides/next/responses-tool-media.md).
Previously stored placeholders are not deleted. Full media decoding remains the provider's responsibility.

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

The 2026-11-05 D07 follow-up adds ten protocol-boundary regression checks, which all fail
before the image admission changes. An isolated disk-backed cold-read regression also fails
before shared initialization. A separate Responses session/private-content close/reopen check
requires both original images in the actual mapped send and refuses a different history owner.
These synthetic disk and substituted-upstream checks do not extend the earlier live-provider
evidence to the new validation behavior.

The tool-text follow-up uses store-boundary negative controls and real disk-owner restart
with substituted upstreams. Exact original parallel tool outputs survive private storage;
count-1 sends one historical image, disabling the window sends both again, and another
owner restart retains them. A supplied private reference fails at request preparation
before content resolution. These checks do not establish installed downgrade, native
client acceptance, live image understanding or crash/disk-pressure recovery.

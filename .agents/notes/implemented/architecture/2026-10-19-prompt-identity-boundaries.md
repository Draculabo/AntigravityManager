# Agent Note: Prompt identity and cache boundaries

Status: implemented

Supersedes: [Claude Agent SDK identity scope](../bug-fix/2026-09-02-claude-agent-sdk-identity-normalization.md)
Supersedes: [OpenAI-specific stale Codex replacement](../bug-fix/2026-09-22-openai-codex-identity-normalization.md)

## Problem

The stable-prefix helper rewrote dates and request/session identifiers so that
semantically different system prompts could share a cache identity. It also
collapsed whitespace outside the metadata owner.

## Decision

Only known client metadata and policy templates may be removed. Dynamic user and
client identity fields remain byte-preserved in the system instruction. Cache
reuse must follow actual prompt identity rather than a guessed normalized string.

The gateway owns two statically registered stages for client compatibility.
OpenAI Chat request rules receive the request and typed opt-in settings before mapping.
System-text rules receive only already-selected text and report the existing
audit kinds at the original mapping points. Account retries use the same
rules and do not configure their activation or order. Initial system text across Claude, OpenAI
conversion/Responses instructions and native Gemini uses the same normalization owner.
Exact standalone Claude Code
and Claude Agent SDK identity templates map to `You are a coding assistant.`.
Live Sonnet tool tasks returned upstream 429 with the Claude Code identity.
The same task completed after the identity was made neutral with the existing
prompt composition and adaptive thinking settings. Otherwise,
only a recognized English identity
opening, identity noun and adjacent attribution verb in the first four sentences
(at most 8192 UTF-16 code units) can become `You are an AI Agent.`. Version decimal
points do not end the sentence. Comma and semicolon continuations preserve their
delimiters and surrounding text. Ordinary business roles without attribution and
later mentions remain.
The old global replace-all of one Codex sentence is removed.

The installed OpenCode client emits an interactive CLI agent opening without an
attribution verb. The normalizer recognizes that complete sentence and the
interactive CLI tool template at the start of a system block. It reuses the
neutral identity and existing transformation diagnostic. This preserves the
tool declarations and any instructions following the identity sentence.

Markdown fences retain their delimiter width and character, including unclosed
fences and mixed backtick/tilde examples. Inline code, blockquotes, XML comments
and explicit quote/example/code/pre regions retain their original text. Metadata
matching uses original line offsets, so the end of a protected span cannot create
a false line beginning in the remaining text. No global trim, empty-line collapse,
placeholder substitution or ID replacement follows restoration.

Client-policy cleanup recognizes the complete security-testing template, including the
opening without `authorized`. A matching opening and a later `# Harness` heading
cannot identify everything between them as a client template. The bounded
transformation diagnostic records only the removal kind and location. Configured
global prompts and ordinary conversation retain their existing ownership.

The [Hermes compact prompt mode](../../../../docs/modules/proxy-gateway/agent-tools.md#compact-hermes-system-prompt)
is selected by a provider-scoped request header on ordinary OpenAI Chat requests.
The default system identity at the start of the first message establishes which
Hermes-generated message to replace. Hermes can assemble project rules and
memory in that slot, so removing its contents requires explicit opt-in. The
mapper receives the compact text before it derives upstream request identity
and tool declarations. Request-local diagnostics record only the transformation
kind and position.

User/tool text and signed/thought history never enter system normalization.
Native system parts carrying either signature alias or a thought marker also
remain unchanged, including their metadata and empty carrier text.
The mapper no longer recursively deletes undefined properties through aliased
tool arguments; optional wire fields remain the serializer/boundary owner's
responsibility. Literal `[undefined]` remains data.

Generation admission rejects empty business input, unanchored assistant starts
and incomplete tool rounds before account selection. Existing association
validators still own call identity. Supported anchored assistant prefill retains
its role and text; only a non-image Gemini target receives one temporary
`.` user tail. A neutral token avoids adding a synthetic instruction to continue.
Counting does not receive this generation-only adapter.
Signed/thought turns retain whitespace companion parts. No dummy thinking or
empty-history business prompt is inserted.

Each system mapper owns one configured global section and preserves its text.
Caller repetitions remain caller data, including quotations and matching section
tags. Substring equality cannot establish gateway provenance. The existing
signature decision retains physical-model and exact-match recovery obligations;
an unspecified provider rejection does not authorize rewriting history, clearing
the signature scope or inventing tool outcomes. See the
[signature decision](../bug-fix/2026-09-09-invalid-thought-signature-recovery.md).

Generation services resolve the global section once before asynchronous selection
and pass the immutable string/null through each remapping path. Each transformation
owner reports closed metadata to the existing request context; 64 retained entries
and a dropped count bound diagnostic memory without copying payloads. The actual
send owner records the full pre-cache estimate, current wire estimate and UTF-8
length after final rebinding, using the same serialized string sent by the transport.
The static native request prefix precedes dynamic contents. See
[the observation decision](../bug-fix/2026-10-10-context-observation-thought-access.md).

## Alternatives considered

Replacing UUIDs and dates with placeholders was rejected because it can merge
requests with different instructions or diagnostics. A recursive body sanitizer
was rejected because tool arguments, media, signatures and XML examples are not
owned by this helper.

Sharing OpenAI's old replace-all was rejected because a quoted or late identity
can be legitimate input. Independent native Gemini cleanup was rejected because
the same system instruction must follow one rule across all Google paths.
Splitting text and applying multiline anchors to each remainder was rejected
because an inline code boundary is not an original line boundary.

## Consequences

Requests that differ only by date or session ID no longer reuse this local
prefix key. That increases cache-key cardinality but preserves prompt meaning
and makes the outgoing request explainable.

Recognized attributed system heads now have the same meaning across protocols.
This is a controlled request transformation, not evidence of a provider WAF or
cache improvement. Empty requests that previously reached generation now fail
with an input error. Bounded mapper transformation diagnostics, physical-send
estimation and global-prompt snapshot now have controlled coverage. Wider diagnostic
UI/accounting and cross-domain acceptance remain tracked D15/D16/D17 work. This decision does not
authorize arbitrary body sanitization or synthetic history repair. Affected
clients follow the [upgrade guide](../../../../docs/upgrade-guides/next/retain-tool-call-history.md).

## Verification

See D12 implementation report (local artifact `D12-prompt-identity-implementation.md` in the 2026-10-11 review collection) and the focused Claude request mapping tests.
The new boundary matrix reproduces 13 failures with 23 passing neighbors before
the change. Controlled controller-to-service paths check all four protocols,
ordinary text preservation, exact outgoing system text and input immutability.
These checks replace account/provider boundaries; native/live-provider behavior
and cache effectiveness remain unverified.
The generation-history follow-up adds actual Responses input conversion and
service-to-upstream checks, cancellation, count exclusion, exact prefill text,
global section ownership and signature rejection without replay. Its evidence
is recorded in the same implementation report.

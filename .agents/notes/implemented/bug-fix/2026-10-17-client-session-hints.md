# Agent Note: Bounded session hints and initial Chat anchors

Status: implemented

## Problem

Alphabetically ordered product headers can select a generic/client hint before
Claude Code. Unbounded IDs and repeated or malformed values lack a clear fallback.
Treating every later system message as initial context changes a conversation's
signature scope during ordinary continuation. The anonymous sentinel also collides
with a credential whose literal value is `anonymous`.

## Decision

One resolver chooses the confirmed product-header order, then sorted generic
session headers, generic aliases, the actual request query, body and metadata.
It excludes transport/request/trace/correlation identifiers. IDs are strings of at
most 128 Unicode code points after outer whitespace trimming. Invalid candidates
fall through; no value is truncated or has characters removed. Header names are
case-insensitive, while conflicting duplicate representations fail that candidate.
Repeated query values must agree. Arrays are not single header IDs.

Chat and Messages consume the winner without combining unrelated header values.
The result exposes source/field and rejected-candidate count as internal diagnostic
metadata, excluding raw hint values. It does not add an automatic diagnostic log or
persist raw hints. Existing user-ID fallback remains hint-only. Tenant digests
distinguish credentials from anonymous mode; authentication itself is unchanged.

Chat anchors include all initial contiguous system/developer messages and ignore
later system additions. Existing empty-user-preamble behavior remains. The initial
task contract remains in place. Tool identity now includes the full name, description
and parameter schema. Signature storage still
requires its exact scoped call/tool/model provenance; account affinity and signature
keys remain distinct under an explicit hint.

The current namespace is `scope:v5`, following the initial task/context split below.
There is no old-key fallback,
broad cache read or forced deletion. This isolates changed derivation rules while
retaining old entries under existing capacity/TTL bounds. Public Responses ID format
is unchanged; persisted-history availability follows its separate ownership and
upgrade decisions below. The existing
[signature-store ownership decision](2026-10-09-signature-session-isolation.md)
continues to own stored signature recovery and its historical evidence.

Account scheduling recognizes a terminal numeric `:step:` pattern in a winning `x-session-id` header
within a presented credential scope and only to the affinity projection. Stored
Responses lineage does not attest to the original hint field and keeps its full
routing identity. Audit export retains the full child session
identity, as do storage and signature-cache keys. Live-client acceptance is pending.

## Alternatives considered

- Alphabetical priority among product headers is deterministic but selects the wrong winner.
- Truncation or character removal merges distinct IDs.
- Accepting repeated conflicting values makes selection depend on representation/order.
- Session hints cannot establish an authenticated tenant.
- Reading old namespaces to improve warm hits permits reuse under superseded rules.
- Taking only the first initial system message omits meaningful initial instructions.

## Consequences

The anchor hash now traverses JSON-shaped data iteratively with explicit framing,
sorted object keys and bounded UTF-16LE string writes. This avoids full message or
Base64 serialization and preserves code units at chunk boundaries. The namespace
advances from the intermediate v2 slice so it never reads signatures under the
previous hashing rule. Equivalent plain text and ordinary function declarations
share a logical `session:store:v2` identity across Chat/Responses/Messages/Gemini, with a
separate explicit-hint `session:affinity:v1` identity. Signature cache projections
remain protocol scoped; a common logical store key does not authorize signature reuse.
Initial developer/system roles and text part boundaries remain significant. Known inline
images now share an explicit media-tagged canonical task representation: normalized MIME
plus a fingerprint of the complete encoded payload. The existing chunked anchor hash is
reused without decoding or whole-message serialization. Text/image order and boundaries
remain significant; image processing detail other than omitted/auto, remote references,
other media, built-in tools and unknown extensions remain protocol scoped. Initial
instruction parsing remains text-only; media-bearing instructions are not guessed equal.
Native Gemini carries its scoped affinity through unary/streaming text/image selection;
D01 continues to own success-only binding. Responses HTTP and WebSocket carry the
original transport context through admission/execution. Responses retains the initial task
fingerprint and client/content origin, preserving them through media bounding and restart.
Generated response IDs do not substitute for client hints. Long or invalid roots are not accepted as
unbounded hints. Persisted-history tenant
authorization has its own [implemented ownership decision](../security/2026-10-17-responses-history-tenant-ownership.md):
a credential-scoped account key does not authorize access to another tenant's response ID.

This is a D03 slice, not whole-domain completion. Broader media equivalence,
upstream identity coverage for auxiliary paths and joint
session/global lifecycle cleanup remain open. Product-specific
JeikCode/AtomCode handling is not introduced; pre-existing generic matching remains.

Older in-memory signatures/affinities can cold-miss after upgrade. Request-local
explicit signatures retain their existing provenance rules. Public Responses cursor
availability is governed by the separate history decision, rather than promised by
this cache namespace change. This validated hint/image slice performs no durable
migration, historical rewrite or provider request.
Real acceptance remains deferred. The earlier ownership note's live evidence does
not establish this new namespace or hint policy.

Generated protocol calls now pass account/store-derived upstream identity explicitly
through generation options. SHA-256 produces a signed 64-bit decimal session ID
without Number rounding or raw account/content exposure; a stable store digest
supplies the request's conversation segment. Every content send gets a new full
request ID at the transport owner, including endpoint/cache fallbacks. Final 4xx
capture records that actual envelope. Only the request wrappers are cloned; message
arrays/media remain shared. The hash uses SHA-256 and retains the signed-integer format.
The client now owns [bounded input-limit recovery](2026-10-17-bounded-upstream-session-recovery.md)
with its separately confirmed attempt and lifecycle limits.
Auxiliary callers without explicit options keep their prior envelope contract.

The [Responses initial identity decision](2026-10-17-responses-initial-identity-metadata.md)
defines `scope:v5` and `session:store:v2`, preserving the initial task fingerprint
separately from current instruction/tool context. Explicit roots survive omitted
later headers, while content-origin requests retain their content-derived identity.
The v3 history cutover deliberately makes earlier cursors unavailable without
importing or deleting old files. Its own controlled matrix passes 530 tests in 42
files; earlier hint/image evidence remains historical.

## Verification

Pure tests exercise product order, source precedence, Unicode bounds, duplicate
conflicts, malformed fallback, transport exclusion and value-free diagnostics.
Protocol-scope tests cover credentials, anonymous separation, initial-system
differences and appended-system stability. The actual signature store demonstrates
an old-key miss while preserving both old and new scoped entries. Controlled gateway
tests preserve streaming/non-streaming signature isolation and tool continuation.
The appended-system regression fails before its fix; source, checks and remaining
limits remain specific to that earlier slice. Its selected regression matrix passed
1,533 tests across 145 files with one inherited ABI-specific skip; later focused
hint/Responses selections passed 61 and 53 tests respectively. Those runs do not
by themselves validate the later `scope:v5`/v3 work.

Known inline-image checks cover four prepared protocol representations, complete payload
changes, MIME/order/context/tenant differences, unknown fields and appended turns. Real
protocol services with a synthetic upstream verify unary/streaming identity propagation
and unchanged image bytes. The final image-anchor selection passed 419 tests in
32 files with zero failures or skips. Two mutation controls detected a constant
payload fingerprint and removed known-field gates; source restoration was checked
by SHA-256. Type, focused lint/formatting, runtime/type boundaries and Agent
contracts passed for that earlier slice.

These are retained summaries of historical controlled checks, not checks rerun for
this documentation correction. Local reports named `D03-session-hints-implementation.md`
and `D03-inline-image-anchor-implementation.md` under the ignored `artifacts/` directory
contain additional logs and detail; they are not required repository links or proof
of a passing current workspace. Broader media, auxiliary callers, D16 cleanup and
final real-provider/installed-client acceptance remain unverified by these checks.

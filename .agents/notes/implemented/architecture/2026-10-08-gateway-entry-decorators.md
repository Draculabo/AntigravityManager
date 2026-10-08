# Agent Note: Gateway entry validation and protocol error decorators

Status: implemented

## Problem

Gateway management handlers explicitly parsed query and path parameters. Batch
and Files/Uploads controllers wrapped operations in response helpers that sent successful
results and translated errors. Thought management mutations also recorded the
same administrative audit after each operation. This repeated transport code
obscured each operation.

## Decision

Audit and thought management parameters use the gateway's
[ZodSchemaPipe](../../../../src/modules/proxy-gateway/server/common/zod-schema.pipe.ts).
Existing schemas remain at their owning entry and preserve coercion, trimming,
defaults, limits and flattened bad-request envelopes. The body-chunk handler
declares its UUID parameter last because Nest resolves parameter Pipes in reverse
order; this preserves UUID-first errors when both path and query are invalid.

Batch, ordinary Files and OpenAI Uploads handlers use
[ProtocolErrors](../../../../src/modules/proxy-gateway/server/common/protocol-errors.decorator.ts)
with their existing dialect mapper. The decorator binds a local Interceptor that
converts mapped bodies and statuses into HTTP exceptions. Guards execute before
Interceptors, so authentication denials retain their existing handling. Handler
HTTP exceptions still pass through the dialect mapper, matching the old helpers.

Ordinary Batch handlers return protocol objects. POST create/cancel explicitly
return HTTP 200. Anthropic JSONL results retain manual response handling and the
synchronous helper; the unused asynchronous helper was removed. Gemini model-entry
batch submission, ORPC, retries, leases, cancellation and
resource cleanup remain outside this slice. No dependencies were added.

Files is the second consumer of protocol error interception, so the former
Batch-owned decorator now belongs in gateway common infrastructure. Its mapper can
read the request to select the shared OpenAI/Anthropic route's dialect. Files uses
method annotations to retain upload-only normalization without stacking two error
Interceptors. Multipart parsing, purpose selection and Anthropic beta checks stay
explicit. OpenAI Uploads is the third consumer and normalizes transport upload
errors only for multipart parts. The unused Files response helper was removed;
Files content downloads retain explicit response headers and error handling in
their controller, keeping transport concerns out of FilesService.

Stored Responses read/delete handlers return protocol objects directly. A shared
local record lookup throws Nest's not-found exception with the existing OpenAI
body. No protocol error decorator is needed here: unexpected store failures retain
the framework's default handling. Generation, continuation and durable state are
unchanged.

Legacy Anthropic completion is another consumer of protocol error mapping. The
mapper receives the reply as well as the request so it can read the header already
assigned by the passthrough handler. This preserves the generated request ID in
success IDs, response headers and error bodies without adding mutable request
state or a new correlation-ID decorator. The handler retains prompt conversion and
stream refusal. Gemini model queries also return their existing protocol objects,
including the successful unknown-model fallback; generation and abort scopes stay
explicit.

Thought management mutations use
[AuditAdminOperation](../../../../src/modules/proxy-gateway/server/modules/observability/admin-operation-audit.decorator.ts).
Its Interceptor records after the operation resolves and before HTTP serialization,
using a typed result projector for affected counts. It applies only to single-result
management operations. Mutation failures do not record success, and recorder
failures still fail the HTTP response after the mutation, matching prior behavior.
Client thinking endpoints retain explicit recording because their boolean result
omits the count; audit-store operations retain service-owned events.

This preserves the ownership established by the
[Batch composition note](2026-08-25-batch-composition.md) and
[OpenAI entry-controller note](2026-08-25-openai-entry-controllers.md).
Framework mechanisms do not introduce new terms in the
[domain glossary](../../../../CONTEXT.md).

## Alternatives considered

- Keep explicit parsers and response helpers: local visibility was retained, but
  repeated transport code remained in operation bodies.
- Introduce a uniform response envelope or decorated DTO classes: the former
  would change protocol contracts; the latter would duplicate existing schemas.
- Install a catch-all controller exception filter: it would also receive guard
  denials and require extra provenance handling to preserve authentication errors.
- Decorate retry and resource lifecycles: this would hide ordered state transitions
  owned by the execution path.

## Consequences

Controller bodies focus on operations and protocol projection. Future entries can
reuse the Pipe and protocol error decorator without a new annotation DSL. Schemas and
protocol differences remain explicit at their owners.

Tests must exercise Nest/Fastify HTTP execution: direct Controller calls bypass
Guards, Pipes and Interceptors. Existing Batch controller tests now use a shared
HTTP fixture, preserving their protocol assertions. Files tests also use actual
multipart and raw-media requests; Uploads and stored Responses also exercise their
production HTTP controllers. The error Interceptor covers handler
and Pipe failures, not later serialization or response-send failures. Migrated
response bodies retain their existing serializable projections.

Current ownership is documented in the [architecture reference](../../../../docs/architecture.md);
regression selection belongs to the [testing reference](../../../../docs/testing.md).

## Verification

- Management, Files API/error, Batch controller/error, Gemini submission,
  cross-dialect conformance, OpenAI Uploads, endpoint coverage, module integration
  and guard-envelope tests passed: twelve files, 221 tests.
- Files tests use actual multipart/raw-media parsing and a temporary file store,
  including cross-dialect read/delete, shared cursors, restart, expiry, download
  bytes/headers and upload status 200.
- Uploads and stored Responses expansion passed eight focused files, 111 tests,
  including response session stores and durability. Uploads store revival tests
  retain their assertions in a separate owning test file.
- Legacy completion and Gemini model-query expansion passed nine focused files,
  158 tests, including the existing Batch, Files and Uploads error consumers,
  cross-dialect conformance, endpoint coverage and module integration. Completion
  tests verify concurrent
  failure correlation, legacy prompt adaptation, explicit stream refusal and
  unchanged guard handling. Gemini model-query tests preserve the protocol-specific
  authentication envelope and HTTP 200 unknown-model fallback.
- Administrative audit tests verify recording after a deferred mutation, zero
  affected counts, exact action arguments, no success event on mutation or guard
  failure, and preserved recorder failure propagation.
- Temporarily bypassing protocol interception failed all three dialect fallback
  tests; bypassing administrative audit interception failed all three success
  recording tests. Both implementations were restored after these negative controls.
- The simultaneous invalid-path/query test detected the initial Pipe ordering
  regression and passed after preserving UUID-first precedence.
- `npm run type-check` and the complete `npm run check:governance` chain passed,
  including runtime and type boundaries.
- `npm run lint` passed with three unrelated existing warnings.
- Native packaging and live-provider checks were not run because this slice does
  not change those execution paths.

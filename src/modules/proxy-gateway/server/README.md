# Proxy Gateway Server Module Guide

---

## 1. Overview & Scope

The `server` directory contains the core backend implementation of the Proxy Gateway module in AntigravityManager, built on the NestJS framework.

### Core Responsibilities
1. **Multi-Protocol LLM Gateway Translation**: Unified handling and orchestration of OpenAI (Chat, Completions, Responses, Media), Anthropic (Messages API), and Gemini (Native Generate/Stream) protocol requests.
2. **Account Lease & Scheduling Management**: Coordination of account loading, candidate selection, rate limiting, quota tracking, sticky sessions, and parity scheduling.
3. **Resilience & High Availability**: Cross-protocol implementation of retry backoff, circuit breaking, model routing, rate-limit tracking, and fallback degradation.
4. **Streaming & WebSocket Transport**: Native support for Server-Sent Events (SSE) and real-time bidirectional OpenAI Responses WebSockets.

---

## 2. Directory Structure

The `server` directory follows a modular NestJS structure, separating feature capabilities into dedicated sub-modules:

```plaintext
server/
├─ README.md                               # Module documentation
├─ proxy.module.ts                         # Root composite module (Proxy Gateway entry point)
├─ proxy.service.ts                        # Facade service (delegates requests to specific protocol services)
├─ common/                                 # Shared abstractions and common boundaries
│  ├─ base-proxy.controller.ts             # Base controller for protocol handlers (SSE, error responses, logging)
│  ├─ base-proxy.service.ts                # Base service for protocol handlers (Request ID, stream timers, error classification)
│  ├─ upstream-4xx-capture.service.ts       # Bounded, redacted diagnostic capture for final upstream 4xx responses
│  ├─ upstream-capture-context.ts           # Request context interceptor feeding diagnostic captures
│  ├─ interfaces/                          # Cross-protocol request, response, and intermediate types
│  │  └─ request-interfaces.ts
│  ├─ exceptions/                          # Unified exception types for upstream request errors
│  │  └─ upstream-request.exception.ts
│  └─ utils/                               # Protocol-agnostic utility functions (e.g., User-Agent parsing)
│     └─ request-user-agent.ts
├─ guards/                                 # Access control and credential parsing
│  ├─ proxy.guard.ts                       # Proxy credential and OpenCode scope validation
│  ├─ admin.guard.ts                       # Admin endpoint permission validation
│  └─ api-key-auth.util.ts                 # API key extraction and normalization utilities
├─ modules/                                # Sub-modules organized by feature capability
│  ├─ openai/                              # OpenAI protocol sub-module
│  │  ├─ openai.controller.ts              # Chat, Completions, Responses, Image, and Audio endpoints
│  │  ├─ openai.service.ts                 # Request orchestration, stream conversion, tool call mapping
│  │  ├─ openai.module.ts                  # NestJS OpenAI module registration
│  │  ├─ responses/                        # OpenAI Responses WebSocket protocol and session store
│  │  │  ├─ openai-responses-session.store.ts
│  │  │  ├─ openai-responses-session.service.ts   # Injectable, restart-surviving session store
│  │  │  ├─ openai-responses-store.controller.ts  # GET/DELETE /v1/responses/{id}
│  │  │  ├─ openai-responses-websocket.protocol.ts
│  │  │  └─ openai-responses-websocket.server.ts
│  │  └─ media/                            # Image and audio multipart input parsing & monitoring summary
│  │     ├─ image-multipart-request.ts
│  │     └─ image-monitoring-summary.ts
│  ├─ anthropic/                           # Anthropic protocol sub-module
│  │  ├─ anthropic.controller.ts           # Messages API route handler
│  │  ├─ anthropic.service.ts              # Request orchestration, stream conversion, session key extraction
│  │  └─ anthropic.module.ts               # NestJS Anthropic module registration
│  ├─ gemini/                              # Gemini native protocol sub-module
│  │  ├─ gemini.controller.ts              # Model listing, content generation, and token counting endpoints
│  │  ├─ gemini.service.ts                 # Gemini request orchestration and SSE passthrough
│  │  ├─ gemini-client.service.ts          # Upstream HTTP client, endpoint failover, explicit context cache
│  │  ├─ explicit-context-cache.store.ts   # Explicit context cache storage
│  │  └─ gemini.module.ts                  # NestJS Gemini module registration
│  └─ account-lease/                       # Account lease and scheduling sub-module
│     ├─ account-lease.service.ts          # Main Account Lease facade service
│     ├─ account-lease.module.ts           # Account Lease module assembly
│     ├─ interfaces/                       # Type definitions, token states, and adapter ports
│     │  ├─ account-lease-token-types.ts
│     │  └─ account-lease-adapters.ts
│     ├─ stores/                           # Token loading, transformation, and in-memory cache
│     │  └─ account-lease-token.store.ts
│     └─ policies/                         # Pure strategy policy implementations
│        ├─ account-lease-config.policy.ts       # Configuration & scheduling mode policy
│        ├─ account-lease-selection.policy.ts    # Candidate filtering, sticky sessions & round-robin
│        ├─ account-lease-quota.policy.ts        # Quota snapshot & recovery calculation
│        ├─ account-lease-quota-refresh.policy.ts# Real-time quota refresh & lockout coordination
│        ├─ account-lease-hydration.policy.ts    # OAuth refresh & account hydration
│        ├─ account-lease-fulfillment.policy.ts  # Token final state confirmation & fulfillment
│        ├─ account-lease-limit.policy.ts        # Cooldowns, model rate limits & error tagging
│        └─ account-lease-model.policy.ts        # Model capability, fallback & output budget policy
└─ shared/                                 # Cross-module shared services (singleton dependencies)
   └─ services/
      ├─ proxy-retry.service.ts            # Retry backoff and token re-selection strategy
      ├─ rate-limit-tracker.service.ts     # Google & generic rate-limit tracking service
      ├─ model-routing.service.ts          # Model identifier normalization & target routing
      ├─ model-availability.service.ts     # Account model capability & availability persistence
      ├─ generation-constraints.service.ts # Output caps and thinking budget constraints
      └─ model-variant-request.service.ts  # Model variant request re-binding
```

---

## 3. Component Responsibilities

| Directory / File | Responsibilities & Design Purpose |
| :--- | :--- |
| **`server/proxy.module.ts`** | **Root Composite Module**. Imports `OpenAIModule`, `AnthropicModule`, `GeminiModule`, and `AccountLeaseModule`, then exports `ProxyService` and the Account Lease module boundary. |
| **`server/proxy.service.ts`** | **Backward-Compatible Facade**. Keeps external invocation signatures stable while delegating actual protocol handling to sub-services (`OpenAIService`, `AnthropicService`, `GeminiService`). |
| **`common/`** | Provides **shared base classes** (`BaseProxyController`, `BaseProxyService`) for protocol controllers and services, alongside cross-protocol request/response types (`request-interfaces.ts`) and exception definitions. |
| **`guards/`** | Enforces NestJS guards for API Key authentication, admin endpoint authorization, and OpenCode token scope verification. |
| **`modules/openai/`** | Manages OpenAI HTTP controllers and service orchestration; the `responses/` sub-directory handles WebSocket protocol state and session lifecycle. |
| **`modules/anthropic/`** | Handles Anthropic Messages API parsing, request transformation, stream response mapping, and session management. |
| **`modules/gemini/`** | Handles native Gemini REST/SSE endpoints; `gemini-client.service.ts` encapsulates upstream Axios calls, multi-endpoint failover, and explicit context caching. |
| **`modules/account-lease/`**| **Account Lease Core**. Employs a Policy design pattern to decouple selection, quota, hydration, and rate-limiting logic into discrete files under `policies/`, coordinated by `AccountLeaseService`. |
| **`shared/services/`** | Houses singleton services shared across feature modules (e.g., `RateLimitTrackerService`, `ProxyRetryService`), ensuring consistent global state across the Proxy Gateway. |

---

## 4. Architectural Rules & Guidelines for Developers & Agents

When reading, updating, or refactoring code within this directory, strictly follow these rules:

1. **Maintain Stable Facade (Facade Pattern)**
   - The root-level `proxy.service.ts` serves as a stable facade. External modules (such as Electron main process `main.ts` or other NestJS modules) should inject `ProxyService` without tightly coupling to specific protocol sub-services.

2. **Singletons & State Consistency**
   - Policies, Stores in `AccountLeaseModule`, and services under `shared/services/` are singletons. **Never instantiate multiple instances**, as doing so will split in-memory locks, rate-limit trackers, and quota state.

3. **Protocol Isolation & High Cohesion (SRP)**
   - Protocol-specific logic is isolated inside `modules/<protocol>`. Modifying OpenAI feature logic must not touch or break Gemini or Anthropic handlers.

4. **Base Class Inheritance Without Code Duplication**
   - Reusable utilities (e.g., Request ID creation, SSE header formatting, stream idle timeouts) must be inherited from `BaseProxyService` / `BaseProxyController` rather than copy-pasted.

5. **NestJS Dependency Injection Standard**
   - All Services and Policies must be annotated with `@Injectable()` and provided via module metadata. Do not use `new` to instantiate Nest-managed services manually.

---

## 4a. Durable Proxy State

State a client can still reference after the process goes away is kept in `~/.antigravity-agent/proxy-state/`, one JSON file per owner, through `shared/persistence/durable-record-store.ts`. Writes are atomic (temp file plus rename) and coalesced, records are bounded by both count and age, and a damaged file costs the affected records rather than the app's start.

| owner | file | bounds | overrides |
| :--- | :--- | :--- | :--- |
| Responses sessions | `openai-responses-sessions.json` | 500 sessions, 1 hour since last use | `AGM_RESPONSES_SESSION_MAX_ENTRIES`, `AGM_RESPONSES_SESSION_TTL_MS` |
| Stored chat completions | `openai-chat-completions.json` | 500 completions, 1 hour since last read | `AGM_STORED_COMPLETION_MAX_ENTRIES`, `AGM_STORED_COMPLETION_TTL_MS` |
| Model route misses | `model-route-misses.json` | 50 ids, 30 days since last seen | `AGM_ROUTE_MISS_MAX_ENTRIES`, `AGM_ROUTE_MISS_TTL_MS` |
| Batch jobs | `proxy-batches.json` | 200 batches, 48 hours | `AGM_BATCH_MAX_BATCHES`, `AGM_BATCH_TTL_MS` |
| Pending uploads | `proxy-uploads.json` | 256 uploads, 1 hour | `AGM_UPLOADS_MAX_PENDING`, `AGM_UPLOADS_TTL_MS` |

`OpenAIResponsesSessionService` owns the file; the store class it extends defaults to memory only, and under the test runner the service takes no path at all, so no test can write into the real data directory.

`GET /v1/responses/{id}` replays the payload the create call answered with and `DELETE /v1/responses/{id}` removes it; both answer 404 in OpenAI's error envelope for an id that is unknown, has aged out, or was created with `store: false`. A `previous_response_id` that cannot be resolved is answered the same way, because a client reads that as "start a fresh conversation" while an empty chain reads to the user as the assistant losing its memory.

`POST /v1/chat/completions` accepts `store: true` on a unary request and keeps the `chat.completion` object it answered with, so `GET /v1/chat/completions/{id}` replays exactly that object -- choices, finish reasons, usage, model and creation time -- and a client that lost the connection reads its answer instead of paying for it twice. An id that was never stored or has aged out is 404, never an empty completion. `store: true` together with `stream: true` is refused with `param: "store"`, because a streamed answer is passed through chunk by chunk and no completion object is assembled to keep; answering 200 and keeping nothing would be a promise this route cannot fulfil.

The two stores are separate files with separate ceilings. They have unrelated lifetimes and unrelated volumes, so a burst of stored completions must not evict live conversation state.

This store is local. It preserves the client contract, but it is no provider-side cache: it saves no tokens and is unreadable from another machine.

Deliberate deviation: `store: false` suppresses retrieval but not continuation. OpenAI refuses both, and this gateway's clients chain with `previous_response_id` while sending `store: false`, so refusing the chain would break them silently for a property they do not use.

---

## 4b. v1internal Diagnostic Passthrough

This surface is absent by default. Set `AGM_V1INTERNAL_PASSTHROUGH=1` **before the proxy starts** to register the explicit diagnostic routes (`POST /v1internal/countTokens`, `POST /v1internal/embedContent`, `POST /v1internal/generateChat`); the variable is read once while Nest assembles its controller graph, so changing it afterwards cannot open the routes. It exists to measure what a vendor method actually answers and must not be enabled for normal proxy use.

It forwards the JSON body unchanged to `https://cloudcode-pa.googleapis.com/v1internal:<verb>` through the existing authorised transport, and it is behind `ProxyGuard` like every other route. The reply preserves Google's status and raw text body, reflects only the correlation headers (`content-type`, `retry-after`, `x-cloud-trace-context`, `x-goog-request-id`, `x-request-id`), and adds `x-antigravity-v1internal-account-id` / `x-antigravity-v1internal-account-email` so it is clear whose quota was charged. The account comes from the normal lease.

Why it is worth having: a claim about the upstream envelope -- that it carries a `traceId`, that a verb is unimplemented -- cannot be checked from inside this codebase, because every product path renders the answer through a mapper first. Only the explicit allowlisted diagnostic routes are registered; undeclared methods return standard 404s.

```bash
curl -i http://127.0.0.1:8045/v1internal/countTokens \
  -H 'authorization: Bearer <the proxy api key>' \
  -H 'content-type: application/json' \
  --data '{"request":{"model":"models/gemini-3-flash","contents":[{"role":"user","parts":[{"text":"hi"}]}]}}'
```

Compare the HTTP status and the raw body rather than a locally rendered wrapper: a rejected verb comes back as Google's own error envelope.

---

## 4c. Local Files API -- a Local Store, Not a Provider File Plane

The provider surface this proxy speaks to (`v1internal` on `cloudcode-pa`) has no file plane at all: no upload method, no `files/*` resource, no `fileUri` fetch. What its generate call does accept is `inlineData`. So `modules/files/` is a **local** content-addressed store: a client uploads once and references the handle afterwards, and the bytes still travel to Google inline on every reference. None of the token savings a provider-side file cache would give are claimed here.

The store is protocol-agnostic and Nest-injectable. It lives in `<agent dir>/proxy-files` (`index.json`, `blobs/<aa>/<sha256>`, `tmp/`), addresses content by sha256 so identical bytes cost one blob, holds 20 MiB per file and 512 MiB per store with `413`-shaped errors, expires handles after 48 hours and sweeps at startup, on a timer and before every listing. Both blobs and index are written to `tmp/` and renamed into place, so a kill mid-write can leave a stray temp file but never a half-written blob the index already advertises.

`FilesService` is the shared injectable capability over that store. `FilesModule` exports it for dependent modules such as Batch and Uploads; it resolves handles before store access and owns create/list/stat/content/delete operations. The OpenAI/Anthropic and Gemini controllers keep route validation and their dialect-specific resource, list, and error envelopes, while a small response helper applies their results to Fastify. A file uploaded through any surface can therefore be read from the others without duplicating controller plumbing:

| surface | routes | id spelling |
| :--- | :--- | :--- |
| Gemini | `POST /upload/v1beta/files`, `GET /v1beta/files`, `GET|DELETE /v1beta/files/{name}` | `files/{id}` |
| OpenAI | `POST|GET /v1/files`, `GET|DELETE /v1/files/{id}`, `GET /v1/files/{id}/content` | `file-{id}` |
| Anthropic | same `/v1/files` routes | `file_{id}` |

OpenAI and Anthropic publish at exactly the same path, so the dialect is chosen per request from the headers: any `anthropic-version` or `anthropic-beta` means Anthropic, everything else is OpenAI. The Anthropic Files beta `files-api-2025-04-14` is required and named in the error when it is missing -- it doubles as the signal that says which dialect the caller wants, and guessing wrong would return an OpenAI-shaped body to an Anthropic SDK.

Two invariants apply to every dialect:

- **Handles are generated, never client strings.** A supplied id is matched against the issued pattern before anything opens the store, so `../secrets` is reported as never issued rather than sanitised, and no client string reaches the filesystem.
- **The declared MIME type is a claim, and magic bytes overrule it.** Upstream rejects a mislabelled `inlineData` part at generation time with an opaque provider error; sniffing at upload means the mismatch is corrected once, where the client can still see it.

OpenAI purposes are limited to `user_data`, `vision`, `assistants_input` and `batch`. The local batch runner consumes `batch` JSONL through the same store; fine-tuning, evals and Assistants output purposes are refused because this proxy has no runtime that could consume them.

Handles are expanded into inline content on the way upstream, in one place for all four request surfaces (`modules/files/file-reference-expander.ts`), because the provider has no file plane to forward a reference to. Gemini's `fileData.fileUri` becomes `inlineData`; an Anthropic `image` or `document` block with a `file` source becomes a base64 source, which the Claude mapper already turns into the same `inlineData`; an OpenAI chat `file` part becomes an image or a `file_data` data URL by MIME type; and `input_image` / `input_file` do the same on the Responses surface. A request that names no handle is returned untouched, so the ordinary path pays one walk and no copy.

Expansion is **fail-closed**. A handle this proxy never issued, one that has expired, and a request arriving when no store is wired are all errors in the caller's own dialect. None of them is dropped, forwarded upstream as an opaque reference, or replaced with an empty part -- upstream would answer any of those with a confusing provider error about content it never received.

`POST /upload/v1beta/files` accepts Google's simple media form, where the whole body is the file. That needs a raw body parser, registered at boot for media content types only and with its own body limit: `application/json` and `multipart/form-data` already have exact-match parsers and Fastify prefers an exact match over a matcher, so every existing route keeps both its parser and its current ceiling.

### OpenAI Uploads protocol

`modules/uploads/` serves `POST /v1/uploads`, `POST /v1/uploads/{id}/parts`, `POST /v1/uploads/{id}/complete` and `POST /v1/uploads/{id}/cancel`. It is not a second capability -- it is a session protocol over the shared `FilesService`: `create` opens an expiring session that remembers the declared byte count, filename, MIME type and purpose; `parts` retains multipart chunks against that session; `complete` names their ids in assembly order, checks that the concatenated bytes match what was declared, and writes exactly one ordinary `file-…` record through `FilesService`. The session and its part records are discarded the moment `complete` or `cancel` runs.

Pending upload sessions and their parts follow the repository's durable/in-memory storage convention: state is managed by `OpenAIUploadsStore` through `DurableRecordStore` at `~/.antigravity-agent/proxy-state/proxy-uploads.json` with defined restart survival, atomic persistence, and base64-encoded part revival validation. In unit test environments, the backing file path is suppressed by default to run entirely in-memory.

Pending sessions are bounded three ways, matching the store they feed into: by size (a declared byte count over the per-file ceiling is refused at `create`, before any bytes are accepted), by time (a session expires one hour after `create` and answers `upload_expired` rather than silently taking more parts), and by count (a fixed ceiling on sessions held at once, configured via `AGM_UPLOADS_MAX_PENDING` / default 256, refused with `429` once reached). A sweep on the same interval as the file store's own reclaims sessions abandoned past their expiry.

`bytes` at `complete` is a claim the assembled parts must match exactly; a short or long result is `byte_count_mismatch` in OpenAI's envelope with `param: "bytes"`, never a silent concatenation. `upload_id` and `part_id` are opaque server-issued strings, checked the same way a file handle is -- never built into a path. `OpenAIUploadsController` acts as a thin adapter delegating to `OpenAIUploadsService` and `sendFilesResponse`.

As with Files, this is **local** session state, not provider-side storage: the file `complete` produces is read back through the ordinary `/v1/files` surface, and every later reference to it still travels to Google inline. No token saving is claimed here either.

## 4d. Local Batch Runner and its Protocol Surfaces

`modules/batch/` is a **local deferred-job runner** over the same `generateContent`-family
calls the proxy already makes for interactive traffic. The provider (`v1internal` on
`cloudcode-pa`) has no batch plane at all -- no batch resource, no deferred submission, no
server-side job -- so this exists to give a client that only speaks batch a real
implementation of the client-facing contract: submit a set of requests, poll, collect
results line by line, survive a dropped connection and an app restart.

**It is not the economics of a real batch API.** There is no 50% discount, no separate
quota pool, and no separate rate limit. Every request costs exactly what it would cost sent
normally, right now, against the same account leases and the same rate-limit tracking
interactive traffic uses. Do not describe it to a client as cheaper or faster than a
unary call.

The runner core is protocol-neutral; `BatchService` is the shared HTTP-adapter boundary above it:

| file | responsibility |
| :--- | :--- |
| `batch-job.types.ts` | Job/request vocabulary, `BatchJobError`, defaults, id parsing/validation, and `SERVABLE_BATCH_ENDPOINTS` -- the exact endpoints this runner can genuinely execute. |
| `batch-job-transitions.ts` | Pure state transitions: restart recovery, cancellation, expiry, claiming, recording an outcome. |
| `batch-request-executor.ts` | Runs one request line against a `BatchExecutionTarget`, isolating a failure to its own `custom_id`. |
| `batch-runner.service.ts` | The durable, bounded, restartable job queue: concurrency, scheduling, persistence. |
| `batch.service.ts` | Shared controller operations: dialect-safe lookup, lifecycle actions, cursor policies, Files integration, and Fastify reply flow. |
| `batch-store-location.ts` | Resolves the backing file under `getProxyStateDir()`, with the usual test-runner path suppression. |
| `batch.module.ts` | Wires the runner to `OpenAIService` / `AnthropicService` / `GeminiService` through a `BATCH_EXECUTION_TARGET` DI token, and registers the OpenAI and Anthropic batch controllers plus the Gemini batches controller (see below). |

State lives in one `DurableRecordStore` at `proxy-state/proxy-batches.json`, bounded by count
(`AGM_BATCH_MAX_BATCHES`, default 200) and age (`AGM_BATCH_TTL_MS`, default 48h). Concurrency
defaults to 2 in-flight requests (`AGM_BATCH_MAX_CONCURRENCY`) because the proxy has no global
concurrency limiter: account leasing hands out an account per request and rate-limit tracking
only reacts to upstream 429s by locking that account out -- a lockout the interactive path then
shares. A batch is by definition not urgent, so it deliberately leaves most of an account's
headroom to whoever is waiting on a live response.

A request that fails is recorded against its own `custom_id` and the batch keeps going; a
cancel stops everything not yet dispatched and discards the answer of anything already in
flight; a batch that outlives its completion window (`AGM_BATCH_MAX_REQUESTS`,
`DEFAULT_COMPLETION_WINDOW_MS`) is expired on read rather than on a timer, and whatever never
ran is marked `expired` while whatever did keeps its real outcome. A kill mid-flight is survived:
a fresh `BatchRunnerService` over the same file resets whatever was `running` back to `pending`
and retries it from the top.

### Protocol surfaces

Each dialect keeps its own controller, resource mapping, and error envelope. `BatchService`
centralizes job lookup, lifecycle actions, the distinct cursor policies, OpenAI Files access,
and common Fastify reply plumbing.

| Surface | Routes | Files |
| :--- | :--- | :--- |
| **OpenAI** | `POST /v1/batches`, `GET /v1/batches`, `GET /v1/batches/{id}`, `POST /v1/batches/{id}/cancel` | `openai-batch-resource.ts`, `openai-batches.controller.ts` |
| **Anthropic** | `POST /v1/messages/batches`, `GET /v1/messages/batches`, `GET /v1/messages/batches/{id}`, `POST /v1/messages/batches/{id}/cancel`, `GET /v1/messages/batches/{id}/results` | `anthropic-batch-resource.ts`, `anthropic-message-batches.controller.ts` |
| **Gemini** | `POST /v1beta/models/{model}:batchGenerateContent` (dispatched from `GeminiController`'s existing model-actions route), `GET /v1beta/batches`, `GET /v1beta/batches/{name}` | `gemini-batch-resource.ts`, `gemini-batch-submit.ts`, `gemini-batches.controller.ts` |

**Gemini surface and naming.** Gemini polling uses `/v1beta/batches` and `batches/{id}` names.
The shared `parseBatchHandle` accepts both `batches/` and `operations/`-prefixed handles, while
only the batches route is published.
`GET /v1beta/batches` supports `pageSize` and cursor-style `pageToken`/`nextPageToken` paging,
the same pattern `OpenAIBatchesController.list` already uses with `limit`/`after`: `pageToken` is
the previous page's last `batches/{id}` name, and `nextPageToken` is omitted once there is no
further page. A malformed `pageToken` is a `400 INVALID_ARGUMENT`; a well-formed token whose
batch has aged out restarts at the first retained page.

**`SERVABLE_BATCH_ENDPOINTS`.** OpenAI batches are gated at both creation and dispatch to
`/v1/chat/completions` only. `/v1/responses` requires the Responses request/response conversion
and `previous_response_id` session resolution to be available outside `OpenAIController`.
Anthropic and Gemini are not endpoint-scoped the same way: `BatchDialect` alone routes a job
to the right handler, so their entries in `SERVABLE_BATCH_ENDPOINTS` (`/v1/messages` and the
`generateContent` action every Gemini batch line ultimately dispatches to) document, and their
own tests prove, the one path each surface actually wires up.

This is a **declared partial-compatibility surface**, not an omission, and it is pinned as one:
`batch-servable-endpoints.test.ts` asserts that `/v1/responses` is refused at creation
(`unservable_endpoint`, `400`, `param: "endpoint"`, naming what can be served) and again at
dispatch, so a record that reaches the runner some other way -- a store written by an older build,
a resumed job -- cannot slip past. Lifting the limitation means moving the Responses
request/response conversion and its `previous_response_id` session resolution out of
`OpenAIController` and into the protocol module, where the batch executor can reach it; that is a
change with its own review, not a flag flip here.

**OpenAI input/output go through the local Files API.** A client uploads its JSONL request
file through `/v1/files` first (purpose `batch`), references it as `input_file_id`, and the
runner reads it back with `FileContentStore.get()` -- never by treating the client-supplied id
as a filesystem path; every handle is parsed through `parseFileHandle` first. Once a batch ends,
succeeded and failed lines are written back into the same store and referenced as
`output_file_id` / `error_file_id`, so the client fetches them with the same
`GET /v1/files/{id}/content` route it already uses for anything else it uploaded.

**Anthropic and Gemini requests are inline**, not file-backed: Anthropic's `requests` array and
Gemini's `batch.input_config.requests.requests` (or the flatter `{requests: [...]}` form) both
arrive in the request body. Gemini's file-input form of `:batchGenerateContent` is not
supported for the same reason `/v1/responses` is not: this runner's inputs are request bodies,
not stored blobs, and accepting a handle it would have to reject at execution time would be
worse than refusing it at submission.

**Errors are answered in the caller's own dialect**, reusing the established per-protocol
envelope builders (`openAIBatchErrorResponse`, `anthropicBatchErrorResponse` --
which wraps the Files surface's own `anthropicFileErrorResponse` --, and `geminiBatchErrorResponse`).
An unknown or expired batch id, or an id created by a different dialect, is always a `404` in
that envelope, never an empty `200`.

**Wiring note.** `GeminiController` needs `BatchRunnerService` to serve
`:batchGenerateContent`, and `BatchModule` needs `GeminiService` to build its execution target.
`GeminiModule` does not import `BatchModule` back to get it -- that static import would recreate
the exact ES-module load-order cycle `forwardRef` only solves at the NestJS DI level, not at
`import` evaluation time. Instead `GeminiController` resolves `BatchRunnerService` lazily through
`ModuleRef.get(BatchRunnerService, { strict: false })`, which walks the whole application's DI
graph rather than `GeminiModule`'s own declared imports.

### Legacy `/v1/complete`

Anthropic's deprecated Text Completions endpoint, served as a thin adapter over the Messages
path (`modules/anthropic/anthropic-complete.controller.ts`,
`modules/anthropic/anthropic-text-completion.ts`) rather than left as a bare 404. The
`\n\nHuman: ... \n\nAssistant:` prompt is parsed back into turns (a prefilled assistant turn is
kept, because that is what it meant on the old endpoint; a prompt with no markers at all becomes
a single user turn), `max_tokens_to_sample` becomes `max_tokens`, and the Messages response is
rendered back as `{type, id, completion, stop_reason, stop, model}` with the leading space the
old API always emitted. Streaming is refused with a `400` rather than half-served: the old
`completion` event stream is a different wire format from the Messages SSE this proxy produces.

---

## 4e. Model Aliases and Route Diagnostics

User-declared aliases live in one ordered list, `proxy.model_aliases`, replacing the two maps
that carried them before (`custom_mapping` and `anthropic_mapping`). A list can say two things
an object could not: the order the user arranged, and `enabled: false` -- an alias parked
without losing what it pointed at.

`migrateLegacyModelAliases` (`modules/config/model-aliases.ts`) folds the old maps into the list
on load and on save, and is idempotent so it can run on both. It folds `anthropic_mapping`
**first**, because routing merged the two as `{...custom_mapping, ...anthropic_mapping}` and the
Anthropic entry is therefore the one deciding a request today; first-entry-wins dedupe has to see
it first or an alias would quietly change target during the migration.

`getConfiguredModelMapping` projects the enabled routes into the exact-map shape the routing
engine and both model catalogs already consumed, which is why neither signature had to change.
One projection serves all three call sites on purpose: a retired alias must neither route a
request nor appear in a published catalog, and asking the same function is what keeps
`GET /v1/models`, Gemini's `models` listing and the router from disagreeing.

Routing itself answers with a **reason**, not just a target. `ModelRoutingService.resolveModelRoute`
returns `{requestedModel, normalizedModel, resolvedModel, source}`, where `source` separates
`canonical` (a rule fired and its target is the key itself) from `built-in`, `configured`,
`dynamic-legacy` and `miss`. That distinction is the whole point: `mapClaudeModelToGemini`
returns its input unchanged both for a supported model and for a model nothing knows about, so
"did any rule fire" could not be asked before.

`miss` is the only case the route-miss journal records, and `resolveModelRouteForRequest` is the
single per-request entry point that records it. Handlers that need the target again downstream
(`countTokensWithLease`) call `resolveTargetModel`, so one request is never counted twice.

---

## 5. Diagnostics

### Upstream 4xx Capture

Set `AGM_UPSTREAM_4XX_CAPTURE=1` to write a redacted JSON pair (the client request and the
converted upstream request/rejection) to `~/.antigravity-agent/captures/` every time
`GeminiClient` receives a final 4xx from the upstream (Gemini is the shared transport for
OpenAI, Anthropic and native Gemini requests). Off by default: capture is a diagnostic aid, not
something every install should pay disk I/O for on every rejected request. Secrets are masked
with `sanitizeObject` before anything is written, only diagnostic allowlisted request headers
are retained, and POSIX capture directories/files use `0700`/`0600` permissions. The directory
is pruned to the newest 50 files. Captures larger than 1 MiB are replaced with a small diagnostic
summary containing their original size, so one rejected request cannot consume unbounded disk
space. A capture failure (e.g. disk full) is logged and swallowed — it never turns the caller's
4xx into a 5xx.

---

## 6. Verification & Development Checklist

After modifying files in `server/`, execute the following verification steps in order:

```powershell
# 1. Static Type Checking
npm run type-check

# 2. Unit Testing (covers Gateway routing, Account Lease policies, retry mechanisms)
npm run test

# 3. Linting & Formatting Check
npm run lint

# 4. Process Boot Verification
# Ensure NestJS dependency injection resolves correctly during Electron main process launch and route handlers register without errors
```

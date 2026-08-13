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

`OpenAIResponsesSessionService` owns the file; the store class it extends defaults to memory only, and under the test runner the service takes no path at all, so no test can write into the real data directory.

`GET /v1/responses/{id}` replays the payload the create call answered with and `DELETE /v1/responses/{id}` removes it; both answer 404 in OpenAI's error envelope for an id that is unknown, has aged out, or was created with `store: false`. A `previous_response_id` that cannot be resolved is answered the same way, because a client reads that as "start a fresh conversation" while an empty chain reads to the user as the assistant losing its memory.

`POST /v1/chat/completions` accepts `store: true` on a unary request and keeps the `chat.completion` object it answered with, so `GET /v1/chat/completions/{id}` replays exactly that object -- choices, finish reasons, usage, model and creation time -- and a client that lost the connection reads its answer instead of paying for it twice. An id that was never stored or has aged out is 404, never an empty completion. `store: true` together with `stream: true` is refused with `param: "store"`, because a streamed answer is passed through chunk by chunk and no completion object is assembled to keep; answering 200 and keeping nothing would be a promise this route cannot fulfil.

The two stores are separate files with separate ceilings. They have unrelated lifetimes and unrelated volumes, so a burst of stored completions must not evict live conversation state.

This store is local. It preserves the client contract, but it is no provider-side cache: it saves no tokens and is unreadable from another machine.

Deliberate deviation: `store: false` suppresses retrieval but not continuation. OpenAI refuses both, and this gateway's clients chain with `previous_response_id` while sending `store: false`, so refusing the chain would break them silently for a property they do not use.

---

## 4b. v1internal Diagnostic Passthrough

This surface is absent by default. Set `AGM_V1INTERNAL_PASSTHROUGH=1` **before the proxy starts** to register `POST /v1internal/{verb}`; the variable is read once while Nest assembles its controller graph, so changing it afterwards cannot open the route. It exists to measure what a vendor method actually answers and must not be enabled for normal proxy use.

It forwards the JSON body unchanged to `https://cloudcode-pa.googleapis.com/v1internal:{verb}` through the existing authorised transport, and it is behind `ProxyGuard` like every other route. The reply preserves Google's status and raw text body, reflects only the correlation headers (`content-type`, `retry-after`, `x-cloud-trace-context`, `x-goog-request-id`, `x-request-id`), and adds `x-antigravity-v1internal-account-id` / `x-antigravity-v1internal-account-email` so it is clear whose quota was charged. The account comes from the normal lease.

Why it is worth having: a claim about the upstream envelope -- that it carries a `traceId`, that a verb is unimplemented -- cannot be checked from inside this codebase, because every product path renders the answer through a mapper first. Verbs are restricted to a plain method name, so nothing but a method name can be appended to the upstream URL.

```bash
curl -i http://127.0.0.1:8045/v1internal/countTokens \
  -H 'authorization: Bearer <the proxy api key>' \
  -H 'content-type: application/json' \
  --data '{"request":{"model":"models/gemini-3-flash","contents":[{"role":"user","parts":[{"text":"hi"}]}]}}'
```

Compare the HTTP status and the raw body rather than a locally rendered wrapper: a rejected verb comes back as Google's own error envelope.

---

## 4c. Local Batch Runner (core only, no protocol surfaces yet)

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

This module currently has **zero controllers** and is not reachable from any HTTP route. It
ports only the runner's core:

| file | responsibility |
| :--- | :--- |
| `batch-job.types.ts` | Job/request vocabulary, `BatchJobError`, defaults, id parsing/validation. |
| `batch-job-transitions.ts` | Pure state transitions: restart recovery, cancellation, expiry, claiming, recording an outcome. |
| `batch-request-executor.ts` | Runs one request line against a `BatchExecutionTarget`, isolating a failure to its own `custom_id`. |
| `batch-runner.service.ts` | The durable, bounded, restartable job queue: concurrency, scheduling, persistence. |
| `batch-store-location.ts` | Resolves the backing file under `getProxyStateDir()`, with the usual test-runner path suppression. |
| `batch.module.ts` | Wires the runner to `OpenAIService` / `AnthropicService` / `GeminiService` through a `BATCH_EXECUTION_TARGET` DI token, so the runner itself never imports a protocol service directly. |

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

Client-facing protocol surfaces -- `POST /v1/batches`, `/v1/messages/batches`,
`:batchGenerateContent`, `/v1beta/operations` -- are a separate task. They need a local Files
API this branch does not have yet, and OpenAI's `/v1/responses` batch endpoint is refused by the
executor today for the same reason: claiming an endpoint works before the conversion it needs is
wired would be exactly the kind of promise this port refuses to make.

---

## 5. Verification & Development Checklist

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

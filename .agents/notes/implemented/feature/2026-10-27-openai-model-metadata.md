# Agent Note: Protocol model directory metadata

Status: implemented

## Problem

`GET /v1/models` published only `id`, `object`, `created` and `owned_by`. That is the whole
OpenAI identity contract, but an OpenAI-compatible client also needs the request budget: how
much conversation history the model accepts and how many tokens one completion may produce.
Without it, clients either assume a small default and compact conversations long before the
model is exhausted, or send an oversized request that the provider rejects.

The gateway already owns both facts. `model-specs.ts` registers per-model output limits for
request clamping, and the OpenCode configuration generator carries the same provider context
windows. Neither reached the public model listing.

## Decision

`GET /v1/models` and `GET /v1/models/{id}` add context and output metadata to
the existing entry. The OpenAI module's request-local model catalog serves both
routes and the service probes, so retrieve returns exactly the object the list
published. The catalog preserves existing membership, raw-only filtering and
configured alias-target resolution. Context/output field aliases carry the same
values for clients that recognize different metadata names.

Discovery now resolves alias targets through the generation router, including
runtime replacements and normalized exact aliases. A common gateway projection
serves the OpenAI and Gemini limit fields. Provider-declared image and thinking
support is published when eligible account evidence agrees. Missing or conflicting
facts stay omitted. An agreed provider output cap can lower the local published
ceiling. These facts describe the current model evidence and do not grant an
account permission to generate.

`context_length` comes from a `context_window` field added to `model-specs.ts`, the catalog that
already owns output limits and thinking budgets. An id the catalog does not register falls back
to its family width (Gemini 1,048,576 and Claude 200,000 input tokens), then to 128,000 for an
unknown family. The fallback keeps newer provider routes useful without borrowing another
family's window.

`max_completion_tokens` reuses `getMaxOutputTokens`, the same value the gateway enforces when it
clamps a request, including its 65,535 default.

A user alias advertises the limits of the model it routes to rather than the alias name's
unknown family. A client that sizes its budget from the listing therefore matches the upstream
call the alias produces.

Gemini list and retrieve use that same spec owner for `inputTokenLimit` and
`outputTokenLimit`, replacing universal 128,000/8,192 placeholders. These are local
gateway specs/family fallbacks, not a measured upstream entitlement or token count.
Lookup on Gemini and Anthropic routes selects an exact ID first, then a single
case-folded match. Multiple folded candidates return the existing protocol 404.

The existing `/v1/models/claude` route emits one complete Anthropic-shaped directory
page with `data`, `first_id`, `last_id` and `has_more: false`. Items and retrieve share
the same `type`, `id`, `display_name` and `created_at` projection. Provider release
dates are unknown, so creation time is the epoch sentinel rather than an invented
release date. The route remains a gateway directory; it does not claim the current
upstream Models API's additional capability/lifecycle fields, cursor filtering or
provider account eligibility. OpenAI model identity output is unchanged.

The D06 follow-up keeps root and `/v1` props/version routes under the proxy guard.
Props reads the same catalog and does not guess capacity for an unpublished model.
Its omitted-model default is the existing `gemini-3-flash`; if raw-only filtering
excludes that ID, the result is an explicit 404 rather than an unrelated model's
capacity. Version identifies this application from its build manifest.

Hermes `agent/model_metadata.py` defines the client discovery order. The HTTP integration fixture sends that sequence directly to the gateway.
Its props response check selects the llama.cpp compatibility branch; subsequent
context lookup requests the named model with `autoload=false`. Its `/version`
check is a vLLM fallback, while `/v1/version` has no confirmed caller in that probe.
The endpoints expose only the adopted discovery contract, not native server
management. No account selection, model loading, upstream call or durable write
occurs, and `total_slots` is only a compatibility placeholder.

## Alternatives considered

- Publishing only the four OpenAI fields keeps the response minimal, but preserves the bug this
  change fixes: every client has to hard-code Antigravity model limits.
- A single hard-coded context constant for all models is simpler, but over-reports Claude's
  smaller window and under-reports Gemini's larger one, so clients compact or fail at the wrong
  boundary.
- Omitting the fields for unregistered ids is honest, but a dynamic route would then look like a
  model with no known limits and clients would apply their own unrelated default. The family
  fallback keeps the answer inside the model's own family instead.
- Deriving these values from the OpenCode catalog would make one module depend on a
  client-specific configuration generator. The shared spec catalog is the neutral owner.
- Keeping OpenAI-shaped Anthropic list items would preserve a protocol mismatch with
  the retrieve route. A single native metadata builder prevents that drift.
- Independent probe fallback tables were rejected because list, retrieve and
  props could then disagree about the same model. Publishing an external client’s identity or fabricating a native engine version would misrepresent the gateway.

## Consequences

The model listing now exposes provider facts that must be maintained with the spec catalog. A
model added only by provider discovery gets the family fallback, not a measured window, until
its catalog entry lands. `max_completion_tokens` describes the gateway's clamp, not a guarantee
about the provider's internal limit.

Clients consuming the former OpenAI-only fields on the Claude subroute must adapt to
the native item fields. The [upgrade guide](../../../../docs/upgrade-guides/next/model-directory-metadata.md)
records the field changes. No persisted catalog or account data is rewritten.

## Verification

`src/tests/unit/model-specs.test.ts` covers registered windows and family fallbacks.
`src/tests/unit/openai-retrieve-model.test.ts` checks list/retrieve equality, concrete limit
values and alias inheritance. `src/tests/unit/proxy-controller.integration.test.ts` pins the
complete list payload, and `src/tests/unit/openai-models-http.integration.test.ts` proves both
routes serialize the fields over a real Nest/Fastify surface. Behavior is documented in
[the compatibility reference](../../../../docs/modules/proxy-gateway/compatibility.md).

The D06 follow-up adds negative controls for native Anthropic item/list equality and
unique Gemini folded lookup. Synthetic raw catalogs exercise empty pages, exact-name
collisions, unknown names and route guards. The shared Nest/Fastify model HTTP fixture
covers both protocol directories; known Gemini limits are pinned independently to
registered specs. No live provider model directory or installed SDK acceptance is claimed.

The D06 probe follow-up adds guarded root/version aliases, exact unknown-model
errors, alias-specific limits and a loopback HTTP discovery sequence based on
the official Hermes consumer. See the implementation evidence (local artifact `d06-model-probes-status.md` in the 2026-11-07 review collection)
for executed checks and installed-client limits.

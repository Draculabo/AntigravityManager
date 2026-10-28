# Agent Note: OpenAI Model Listing Metadata

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

`GET /v1/models` and `GET /v1/models/{id}` add `context_length` and `max_completion_tokens` to
the existing entry. One private entry builder serves both routes, so retrieve continues to
return exactly the object the list published.

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

## Consequences

The model listing now exposes provider facts that must be maintained with the spec catalog. A
model added only by provider discovery gets the family fallback, not a measured window, until
its catalog entry lands. `max_completion_tokens` describes the gateway's clamp, not a guarantee
about the provider's internal limit.

## Verification

`src/tests/unit/model-specs.test.ts` covers registered windows and family fallbacks.
`src/tests/unit/openai-retrieve-model.test.ts` checks list/retrieve equality, concrete limit
values and alias inheritance. `src/tests/unit/proxy-controller.integration.test.ts` pins the
complete list payload, and `src/tests/unit/openai-models-http.integration.test.ts` proves both
routes serialize the fields over a real Nest/Fastify surface. Behavior is documented in
[the compatibility reference](../../../../docs/modules/proxy-gateway/compatibility.md).

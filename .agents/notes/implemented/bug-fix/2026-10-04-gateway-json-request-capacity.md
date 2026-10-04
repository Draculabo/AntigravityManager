# Agent Note: Gateway JSON request capacity

Status: implemented

Production JSON parsing accepts long conversations and inline media within an explicit bound.

## Problem

The production Fastify adapter inherited its 1 MiB JSON default. Long conversation histories and inline media received HTTP 413 before any controller or authentication guard could process them. Route-specific image generation limits did not raise the other JSON parsers.

## Decision

Use the production adapter's route hooks to set a 64 MiB JSON limit on model conversation, completion, token-counting, batch creation, and enabled diagnostic routes. Keep the 1 MiB default on administrative, cancellation, and other non-model routes. The gateway-owned proxy.constants module defines the model route policy. Keep image-generation, raw-media, multipart, decoded-image, and file-storage limits independent. This changes parsing capacity without relaxing authentication or upstream validation.

## Alternatives considered

- Raising the instance-level default would also increase pre-authentication parsing memory for administrative and control requests that do not need large payloads.
- Raising only individual chat routes would leave Responses, token counting, batches, and other model entry points inconsistent; the route policy covers these related model surfaces together.
- An unbounded parser would remove a useful memory bound.
- A media regular-expression parser cannot replace the exact application/json parser Fastify selects.

## Consequences

One model JSON request may now allocate substantially more memory before authentication. Scoping the larger limit reduces unnecessary allocation on administrative routes but does not eliminate concurrent memory amplification. This is a per-request ceiling rather than a process memory budget or upstream acceptance guarantee. Changes to the ceiling require checking both parser boundaries and decoded media limits. Existing route overrides remain authoritative.

## Verification

gateway-body-limit.test.ts checks 2 MiB requests across all model and diagnostic routes, control-route rejection, exactly 64 MiB and one byte above it, and the independent image boundary. Each test closes its Fastify instance. gateway-json-body-limit.test.ts exercises the production bootstrap and real parsers with isolated handlers, including downstream authentication and the control-route ceiling. gateway-endpoint-coverage.test.ts uses the production adapter factory with the real Nest controller graph and guards. Adjacent startup and image route-limit tests remain required. No live-provider payload or account is used.

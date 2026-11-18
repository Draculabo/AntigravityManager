# Agent Note: Bounded gzip model request ingress

Status: implemented

## Problem

Clients that send gzip JSON could not use the model gateway. The default JSON
parser runs before Nest guards, so decoding there without an admission check
would allow unauthorized requests to consume decompression resources.

## Decision

The Fastify pre-parsing hook reuses the proxy IP and API key policy before
starting a gzip stream. It limits both encoded and decoded bytes to the route's
existing ceiling. Fastify validates content length and parses the resulting JSON.
Audit reads the parsed value after the hook, and Nest still owns handler admission.
See [JSON request capacity](../../../../src/server/gateway/README.md#json-request-capacity).

## Alternatives considered

Decoding at the JSON parser without early authorization would expose the
decompressor to unauthenticated traffic. A whole-buffer decoder would retain
both bodies and delay rejection of oversized chunked requests. A global decoder
would also change administrative, raw file, and multipart endpoints.

## Consequences

Valid compressed model JSON follows the existing request path and audit policy.
Oversized, malformed or interrupted streams terminate before model execution.
The bounds apply to an individual request. They do not set a process-wide budget.

## Verification

The [HTTP ingress checks](../../../../src/tests/unit/d07-media-ingress-http.test.ts)
exercise authorized and denied requests, parsed audit data, corrupt and unsupported
encoding, encoded and decoded limits, and ordinary uncompressed JSON. A local curl
run exercises a compressed file over HTTP with a synthetic gateway credential.

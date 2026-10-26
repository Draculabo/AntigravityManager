# Agent Note: Cloud Code content HTTP identity

Status: implemented

## Problem

Google Daily returned HTTP 404 for the gateway and HTTP 200 in a separate comparison run
sending the same model and text. The gateway used the IDE-style
`antigravity/2.x windows/amd64` HTTP User-Agent. The comparison request used
`antigravity/hub/2.17.0 (aidev_client; os_type=windows; arch=amd64; cl=986210228)`.

## Decision

`GeminiClient` uses `buildContentRequestUserAgent` for content HTTP requests. The verified
Hub version and build remain a paired constant. Platform and architecture use existing
normalization. Discovery and envelope identity remain under their current version resolver.
See [the current reference](../../../../docs/modules/proxy-gateway/stream-tool-compatibility.md).

## Alternatives considered

- Broad 404 endpoint fallback: the Sandbox probe also returned 404 and Production returned 429. Neither result explained the successful Daily request.
- Replacing account credentials: a separately authorized one-time run with the comparison token still returned 404 with our HTTP identity.
- Request-body changes: adding an inner model, changing the envelope User-Agent or using
  the reference request’s thinking budget individually still returned 404.
- HTTP/2: the same account/body/header over HTTP/2 still returned 404.
- Changing the entire shared identity resolver: this would also affect discovery, account
  readiness and envelope behavior without evidence that those changes are necessary.

## Consequences

Only the content transport header changes. Endpoint, account, retry, tool and usage policies
retain their owners. The upstream may revise accepted Hub identities; update the version/build
pair with live evidence rather than an IDE version guess. The controlled generation-failure
checks do not establish how often a live model emits malformed tool calls.

## Verification

The bounded live probe held account, token, body, model and endpoint constant. Baseline,
comparison-token and HTTP/2 probes returned 404; changing only HTTP User-Agent returned 200
with candidates. Credentials and model output were not exported. Original account/config
files were read only; isolated profiles and private logs were removed.

Unary and streaming transport-boundary regressions failed before the fix with the old header.
After the fix, 109 focused tests, TypeScript and focused ESLint passed. The rebuilt standalone
core passed all three live Google acceptance scenarios: default finish-chunk usage, independent
usage and exact tool argument passthrough. Each returned HTTP 200 with complete audit bodies.
The isolated process shut down and the original configuration hash remained unchanged.

Final native acceptance evidence is maintained in the local ignored
`artifacts/protocol-tool-compatibility-2026-10-10` directory. The header comparison establishes
the accepted complete identity; it does not identify which individual version/format/build
segment controls Google's internal routing.

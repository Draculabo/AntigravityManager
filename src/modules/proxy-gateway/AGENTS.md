# Proxy Gateway Instructions

These instructions supplement `src/modules/AGENTS.md` for the proxy gateway.

## Compatibility surfaces

- OpenAI, Anthropic and Gemini request/response formats are external compatibility surfaces. Preserve required fields, event ordering, termination semantics, tool calls, usage accounting and error behavior.
- Keep streaming and non-streaming paths semantically aligned where the protocols expose equivalent behavior.
- Do not silently discard an unknown upstream error, malformed stream event or unsupported model route. Fail at the earliest point that can name the problem safely.
- Keep provider-specific behavior in its provider or protocol adapter. Shared routing, quota, retry and persistence policies remain provider-neutral unless the external contract requires otherwise.

## Ownership and enforcement

- Controllers own transport parsing and response mode; services own operations; mappers own protocol conversion; stores own durable state.
- Enforce authentication, request limits, model availability and account-lease policy in the execution path that performs the operation. UI visibility and schema omission are not enforcement.
- Apply byte, item and time limits where the complete emitted or retained value is known, including wrappers and metadata.
- Publish response/session state only after its owning operation reaches the intended commit point.

## Security

- Never expose upstream credentials, proxy administrative secrets, raw authorization headers or unbounded provider payloads.
- Treat provider responses, tool arguments, uploaded files, WebSocket frames and persisted response data as untrusted runtime input.
- Sanitize public errors while retaining enough stable information for clients to respond correctly.

## Required evidence

- Mapper changes require the owning protocol mapper tests.
- Streaming changes require streaming state/mapper, malformed-input and error-path coverage.
- Routing, retries, quota or leasing changes require the owning policy/service tests.
- Endpoint changes require endpoint-coverage and controller integration tests.
- Externally visible protocol changes require real-path parity coverage when that harness supports the affected path.
- Changes to durable Responses behavior require store, session and durability tests.

Use the focused commands and surface map in [docs/testing.md](../../../docs/testing.md). A protocol, durable format, authentication or cross-module ownership decision also requires an Agent Note.

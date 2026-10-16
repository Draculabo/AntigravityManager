# Gateway Testing

This reference selects protocol, routing and tool-configuration evidence. Follow the [global testing policy](../../testing.md) and the linked acceptance procedures for live providers.

Run commands from the repository root unless a step specifies another directory.

## Schema and signature evidence

Schema regression coverage includes `json-schema-reference-resolver`, `schema-admission`, tool
mapper/cache compatibility and Responses WebSocket tests. Runtime reporting adds
`error-reporting-runtime`, `core-error-reporting`, desktop preference propagation, instrumentation,
core shutdown/startup and RPC coverage. Read-only audit replay and live coding-client/provider
calls are separate gates. See [Schema conversion](schema-conversion.md#diagnostics-and-acceptance).

`scripts/acceptance/schema/check-history-evidence.mjs` checks controlled missing-result failures
and anonymous audit-attempt grouping using Node SQLite fixtures. Live history/resubmission and
signature-recovery checks use the [live Schema workflow](schema-conversion.md#live-schema-acceptance).
The local history evidence (`artifacts/schema-work-package/history-verification.md`) distinguishes
client resubmission, observed internal recovery and remaining retry coverage.

`node --test scripts/acceptance/schema/check-client-matrix.mjs` checks actual-client declaration
shapes, read-only forwarding guards, fixed-file MCP behavior, final-answer/result-continuation
predicates and per-request upstream correlation. The real three-client matrix is a separate
quota-consuming gate in the [live Schema workflow](schema-conversion.md#live-schema-acceptance).
Client-local permission failures remain failures; successful MCP execution does not establish
native Shell sandbox compatibility. Anonymous live records distinguish those tool paths.

`check-retry-evidence.mjs` exercises a real loopback socket reset, bounded account-fault
injection, SSE forwarding and per-request audit predicates. Live retry acceptance requires
actual provider tool calls and both controlled results; fixture success alone does not prove
provider acceptance. Thought-only unary completion coverage runs through the Anthropic real
service path with Gemini/parity coverage for the shared fallback. See the
local retry record (`artifacts/schema-work-package/retry-verification.md`) for disclosed injections,
natural provider failures and the remaining scope.

The Schema work package uses the configured default primary route for required live
tool/result and Schema diagnostic receipt acceptance. Backup-endpoint failover probes are
supplementary. Their failed predicates remain failures without blocking that scoped package;
they never establish a change in production endpoint policy. The
local acceptance record (`artifacts/schema-work-package/retry-verification.md#acceptance-scope`)
owns the user-confirmed scope and its evidence.

Replay selection tests also compare default and unmarked cohorts through the compiled CLI.
They require case-insensitive acceptance-header exclusion before limiting, conservative
exclusion of unknown header provenance and no-evidence exit 2 for an all-marked sample.
The local budget sample record (`artifacts/schema-work-package/budget-sampling-2026-10-09.md`)
separates observed converter behavior from unsupported organic-traffic claims.

The isolated startup checks use the [live Schema workflow](schema-conversion.md#live-schema-acceptance).
`check-startup-evidence.mjs` exercises the production launcher and acceptance helper with a
controlled clock, including unavailable and stalled management probes and early child exit.
The local startup record (`artifacts/schema-work-package/startup-verification.md`) separates the
verified acceptance deadline correction from the unexplained historical timeout.

`signature-utils.test.ts` checks exact preservation of opaque provider signatures, including
Base64-encoded ASCII protobuf bytes and non-text binary bytes. `proxy-signature-roundtrip.test.ts`
exercises streaming and non-streaming Anthropic, OpenAI Chat and Responses tool continuations
through the production services with synthetic upstream responses. These assertions compare the
next upstream signature with the original encoded value; they do not establish live Google
acceptance. Run the adjacent isolation, Responses mapper and invalid-signature recovery suites
when changing this boundary.

## Upstream proxy configuration

For upstream proxy configuration, run `upstream-proxy-config.test.ts`,
`upstream-proxy-settings.test.ts`, `service-config.test.ts`, `desktop-oauth-login.test.ts`
and `standalone-core-oauth-login.test.ts`. They cover saved-address validation, atomic clearing,
concurrent updates, UI recovery and OAuth rejection before browser launch. Use a 15-second test
timeout for the private management endpoint tests.

`upstream-proxy-http.test.ts` uses real loopback sockets to verify explicit HTTP proxy routing.
For an optional live connectivity check, set `AGM_LIVE_UPSTREAM_PROXY_URL` to a running HTTP(S)
proxy address before running that file, and restore the environment variable afterwards. The
live case sends only a synthetic invalid token and expects Google's 401 response; it does not
perform authorization, save accounts or establish successful token exchange. A TUN connection
alone does not prove the explicit proxy path; the loopback test checks that path separately.

## Coding tool configuration

For coding tool configuration, run `agent-tools.test.ts`, `cli-agent-tools.test.ts`,
`agent-tool-sync-card.test.ts`, `opencode-model-sync-dialog.test.ts`, `opencode-installation.test.ts`
and `service-config.test.ts`. They cover file recovery, secret projection, write failure, selection,
CLI confirmation and shutdown dependencies. Also run `core-rpc.test.ts` and
`gateway-adapter.test.ts` when the selected-owner wiring changes. Build core and CLI after
changing the TOML dependency. These checks do not replace real installed-client requests;
report platform and upstream evidence separately using the [SOP](acceptance/live-agent.md).

## Proxy-gateway coverage

The proxy gateway exposes several compatibility surfaces. Select tests by protocol and behavior rather than running every proxy test automatically:

- Request and response conversion: the owning OpenAI, Anthropic or Gemini mapper tests.
- Streaming changes: streaming mapper/state, malformed-stream and stream-error tests.
- Tool behavior: tool mapper, namespace and custom tool-call tests.
- Model routing: model availability, alias agreement and routing-policy tests.
- Retry, quota and account leasing: the owning policy/service tests.
- Public endpoint changes: endpoint coverage, controller integration and real-path parity tests.
- Management parameter Pipes: [observability controller integration tests](../../../src/tests/unit/observability-controller.integration.test.ts), including coercion/defaults, complete bad-request envelopes, rejection before storage access and path-before-query error precedence.
- Batch error decorators: [HTTP error integration tests](../../../src/tests/unit/batch-protocol-errors.integration.test.ts) and the owning OpenAI, Anthropic and Gemini Batch controller tests. Exercise the real Nest/Fastify pipeline; direct controller calls bypass Guards, Pipes and Interceptors. Preserve complete dialect envelopes, authentication denials, POST status 200 and JSONL headers.
- Files error decorators: [Files HTTP integration tests](../../../src/tests/unit/files-protocol-errors.integration.test.ts) and [Files API tests](../../../src/tests/unit/files-api.test.ts). Cover per-request dialect selection, upload-only normalization, beta checks, authentication, complete error envelopes, POST status 200 and binary download headers using actual multipart/raw-media requests.
- OpenAI Uploads adapters: [Uploads HTTP error tests](../../../src/tests/unit/openai-uploads-errors.integration.test.ts) and [Uploads protocol tests](../../../src/tests/unit/openai-uploads.test.ts). Cover complete error envelopes, guard denials, part-only normalization, multipart parsing order, POST status 200, assembly, cancellation, expiry and restart. [Uploads store tests](../../../src/tests/unit/openai-uploads-store.test.ts) cover persisted-record revival and capacity independently of HTTP.
- Management operation audits: [observability controller integration tests](../../../src/tests/unit/observability-controller.integration.test.ts). Verify success-only recording after deferred mutations, exact affected counts including zero, unchanged repair results, and propagation of recorder failures.
- Stored Responses adapters: [controller HTTP tests](../../../src/tests/unit/openai-responses-store.controller.test.ts) cover replay, delete, missing records, authentication and unexpected store failures. Durable Responses behavior also requires response/session store and durability tests.
- Legacy Anthropic completion adapter: [controller HTTP tests](../../../src/tests/unit/anthropic-complete.controller.test.ts) cover prompt conversion, stream refusal, complete error envelopes, HTTP 200 and per-request correlation between headers and bodies, including concurrent failures. Guard denials bypass completion error mapping.
- Gemini model queries: [model HTTP tests](../../../src/tests/unit/gemini-models-http.integration.test.ts) cover complete catalog metadata, known and unknown model projections, authentication and unexpected catalog failures. Existing controller tests cover presets and raw-quota filtering.

When a change affects both streaming and non-streaming paths, test both. When it changes externally visible protocol output, prefer exact object or event-sequence assertions over checking individual fields independently.

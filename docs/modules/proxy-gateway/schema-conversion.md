# Proxy Schema Conversion

This reference describes the implemented Schema admission path. The
local execution record (`artifacts/schema-work-package/verification.md`) separates local regression,
live client/provider evidence and remaining budget calibration. Acceptance for one model does
not establish compatibility with every configured client or upstream model.

## Conversion contract

The gateway resolves local JSON Pointer references against the original document, including
`$defs`, `definitions`, nested paths, array indexes, percent encoding and `~1`/`~0` escapes.
Own-property lookup prevents inherited keys from becoming reference targets. Repeated references
are valid; only targets active on the current expansion stack indicate a cycle. Unused definitions
are omitted. Values in `const`, `enum`, `default` and `examples` are data, not reference edges.

Existing branch collapse, reference sibling precedence, enum handling and validation hints remain
upstream compatibility transformations rather than a complete JSON Schema validator. External
references, named anchors, dynamic references and nested resource scope changes are unsupported.
The converter fetches no reference resources.

| Finding                                            | Result                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Unconvertible tool child node                      | Fixed string fallback; retain tool, siblings and parent `required` |
| Unconvertible tool root                            | Local input error                                                  |
| Structured-output conversion failure at any node   | Local input error                                                  |
| Invalid JSON data or input/request budget overflow | Local input error                                                  |
| Unexpected converter exception                     | Existing server-error behavior                                     |
| Omitted tool parameter schema                      | Empty object with empty `properties`                               |

Fallback nodes contain exactly:

```json
{
  "type": "string",
  "description": "Schema conversion fallback. Provide this parameter as a string."
}
```

HTTP Schema input errors use status 400 and `invalid_request_error` in the caller's protocol.
Responses WebSocket uses an `error` event with `invalid_request_error` and `invalid_schema`.
Schema rejection precedes account leasing, upstream execution and streaming publication. A
rejected WebSocket Schema does not replace admitted socket configuration. History repair and
quota/model policies retain their current owners and behavior.

## Bounds and cache

Defaults are depth 64, 10,000 input nodes and 1 MiB per Schema, with request accounting limited
to 50,000 nodes and 4 MiB. Accounting includes input, expansion and the final compatibility
result; these are conservative operation budgets, not only the serialized HTTP body size.
Local reference expansion is bounded and may degrade an eligible tool subtree. Aggregate
overflow cannot be recovered through a string fallback.

Successful tool declaration cache entries retain the existing bounded TTL/entry policy and
return fresh copies. Degraded declarations are not cached. Account retries reuse request-owned
prepared schemas rather than repeat conversion. Initial limits require calibration using
intact real client schemas.

## Diagnostics and acceptance

The diagnostic summary contains only protocol, issue categories, recovery flags, tool ordinals
and bounded counts. It excludes names, schema/ref text, prompts, accounts and filesystem paths.
Sentry diagnostic events remove inherited request, user, breadcrumb and recent-log context.
Disabled reporting or unavailable transport leaves local logs available; submission is not a
delivery guarantee. See [security](../../security/diagnostics.md#schema-diagnostics-and-node-reporting).

Schema replay uses `pnpm run test:schema:replay <audit-database-path>` with the pinned Node runtime, which
provides `node:sqlite`. It requires read access to the audit
database and its SQLite sidecars, and writes only compiled replay code to a temporary directory.
Results with no intact tool/output Schema samples do not satisfy the real-data gate. Selection and privacy requirements are described below.

Use `pnpm run test:schema:replay <audit-database-path> [limit] [all|unmarked]` for read-only replay. The bounded
limit defaults to 1,000 records. Selection joins request metadata and filters model traffic for
OpenAI, Anthropic and compatible protocols before applying that limit; IPC/admin data cannot
consume the sample window. Bodies must be complete, nonpartial, nonoversized JSON. Replay verifies
chunks and hashes, excludes redacted Schema data, and outputs only aggregate statistics. It never
exports requests or credentials. A zero replayed-schema count returns `available: false` and exit
code 2, distinct from success (0) and an execution failure (1). `test:schema:selection` verifies
this contract through the actual compiled CLI against isolated synthetic audit databases.

The default `all` cohort includes controlled acceptance requests. `unmarked` excludes requests
with an `x-schema-acceptance` header key, case-insensitively, before the sample limit. It also
excludes missing, malformed or nonobject stored headers. Header values never leave memory.
An unmarked request is not proven organic traffic: older probes or other test clients may lack
the marker. Neither cohort alone establishes a production failure rate or all-client budget
calibration. Selection/provenance exclusions do not enter body-integrity counters.

`pnpm run test:schema:client <claude-executable> [Read|default|configured-mcp|configured-full]` runs a real Claude Code client
in bare mode against a local controlled response server. The default Read mode limits the declared
tool set; `default` samples the built-in declarations available in bare mode. Execution remains
allowlisted to Read in both modes. MCP/plugins/session persistence are disabled and authentication
uses a synthetic local API key. Schemas remain in memory; the client reads only a newly created
probe and returns its result. This verifies client-generated schemas and result continuation,
without proving provider acceptance or covering every configured client/MCP tool set.

The configured modes load the existing credential-free local CodeGraph, Memory and Sequential
Thinking servers through a temporary strict MCP configuration. Cached npm servers start with
`--offline`; other servers and credential-bearing configurations are excluded. `configured-full`
uses default declarations with isolated client settings and disabled hooks; `configured-mcp`
retains bare mode. Tool search is disabled so declarations appear in actual requests. Only Read
and the built-in MCP startup wait are execution-allowlisted. The sampler retains aggregate
counts, operation budgets and converted-schema hashes, never raw schemas or client context.

`pnpm run test:schema:sentry` runs the real Node SDK from the prepared standalone runtime against
a local envelope receiver. It checks one isolated event and excludes inherited synthetic private
context. It sends no remote Sentry event. Live tests must separately verify provider tool calls
and actual remote Sentry receipt. These acceptance commands never alter client-global settings.

The [live gateway workflow](#live-schema-acceptance) uses the prepared core,
existing account policies and read-only controlled tools. It records final tool-result matches,
local diagnostic summaries, physical upstream models, remote event identifiers and shutdown
restoration. A failed model cycle remains a failed check even when other cycles succeed.

The same workflow includes a real Codex/OpenCode/Claude Code client matrix. Protocol schemas are
measured from actual declarations, including Responses namespaces; custom tools without JSON
parameters are counted separately. Execution is restricted to newly created read-only probes.
Client success requires tool-result continuation and a matching final answer, backed by actual
upstream audit attempts. Controlled declarations extend compatibility evidence but do not
establish an organic budget distribution or validate arbitrary client tool configurations.

Responses restores MCP function names and namespaces from the request's declarations. Flat
MCP names retain their existing form. Function/custom call input preserves the validated
namespace when rebuilding upstream tool history. Streaming, unary and fallback output paths
use the same declaration context; successful upstream HTTP status alone does not prove that
the client can dispatch a returned tool.

Anthropic streaming emits a signature carrier before signed visible text and closes both blocks.
A signature-only fragment after visible text remains in the scoped signature store without
adding an empty final client message. This preserves Claude Code's final answer while retaining
the existing tool/signature history policy.

The Anthropic request boundary preserves `tool_choice`. Object and string auto/none choices map
to Gemini AUTO/NONE; required/any choices use ANY. Named Anthropic tools and OpenAI function
choices include allowedFunctionNames. Omitting a choice retains VALIDATED. This does not enforce
the client option disable_parallel_tool_use.

Unary Gemini responses containing only thought parts without a finish reason do not complete
an answer. The shared generation path uses its existing single stream-aggregation fallback
with the same request and account. If the aggregate is still unfinished thought-only content,
the operation fails instead of emitting a successful empty answer. Explicit terminal reasons,
including MAX_TOKENS and MALFORMED_FUNCTION_CALL, retain their existing protocol behavior.

## Live Schema acceptance

Acceptance output under `artifacts/` is local workspace data and is ignored by Git. Generate it with the workflows below; referenced execution records are available only in the workspace where those checks ran.

`node scripts/acceptance/schema/run-client-matrix.mjs [all|codex|opencode|claude]` runs the installed
Windows clients through the default gateway and real Flash upstream. It requires the prepared
standalone runtime, an unowned stopped profile and usable accounts. Each client uses isolated
temporary settings and a new probe file; the loopback relay forwards original request bytes,
replaces synthetic credentials privately and buffers bounded responses to reject unsafe tool
instructions. Codex uses a temporary stdio MCP tool that reads only the fixed probe; its Windows
Shell execution-policy failures remain separate failed evidence. OpenCode permits reads and
searches, with the relay enforcing the fixed-file target; Claude Code declares default tools and
the inspected credential-free local MCP servers. Successful provider responses are never
simulated. The gate requires an actual tool-result continuation, a matching final answer and
correlated successful upstream attempts for every request. Recovered failures remain visible
in anonymous evidence. Cleanup must restore the stopped state, preserve saved settings and
remove the owned temporary profiles. This workflow consumes quota and writes only aggregate
evidence under `artifacts/schema-work-package/live-results`; it does not perform a separate
remote Sentry receipt check or calibrate budgets from organic traffic. Run
`node --test scripts/acceptance/schema/check-client-matrix.mjs` for its protocol, guard, continuation
and audit evidence controls.

After `pnpm run prepare:standalone`, use `pnpm run test:schema:live gemini-3.1-pro-high` to test
ordinary and degraded tool parameters against the real gateway and Google upstream. The harness
also exercises current native Gemini Flash/Pro routes and installed Claude Code's Read tool.
Use `pnpm run test:schema:live gemini-3.7-flash-high` for ordinary/degraded Flash tool loops;
this is also the default model. The explicit `gemini-3-flash` option retains the retired-route
failure probe. A provider retirement notice does not count as a successful tool call. It requires an
unowned stopped profile, existing usable accounts, enabled desktop reporting preferences and
configured Sentry credentials. The bundled read-only Sentry helper requires `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG` and `SENTRY_PROJECT`; values are resolved in memory from the shell/build environment.

This command consumes provider quota and sends controlled diagnostic events to the configured
remote Sentry project. Newly created probe files are the only allowed tool targets. It starts
the core temporarily and shuts it down afterward, without saving proxy auto-start or client
settings. Loopback observation relays forward the real client requests and SDK envelopes to
their configured destinations; only bounded anonymous evidence is written under
`artifacts/schema-work-package/live-results`. A single failed cycle makes the command fail.
Ordinary acceptance also fails when remote Sentry receipt cannot be confirmed; an outbound
envelope or HTTP 200 alone is insufficient. The relay records anonymous transport status to
distinguish delivery failures from event-query failures.

Append `client-mcp` to use default Claude Code declarations and the three inspected credential-free
local MCP servers. This verifies actual declaration acceptance and a controlled Read cycle;
it does not execute MCP business tools. Append `history` to acquire two real parallel calls and
compare combined, adjacent and reversed-result histories without rewriting production history.
Append `history extended` to compare identical resubmissions and bidirectional Pro/Flash
continuation, choosing the source model in the first argument. Append `history recovery` to
mutate only signatures in a controlled history and require final result matches plus actual
upstream 400/200 attempts for one gateway request. A provider accepting the mutation does not
prove recovery and keeps this check failing. Audit evidence retains anonymous scenario labels
and per-request attempt counts. `node scripts/acceptance/schema/check-history-evidence.mjs`
checks missing-result sensitivity and private audit-context exclusion using isolated fixtures.
`node scripts/acceptance/schema/run-core-startup.mjs 5` isolates the prepared core's readiness
and shutdown without submitting gateway requests or intentional diagnostic events. It requires
an unowned stopped profile and restores that state; forced cleanup fails the command. Append
`trace` for fixed test-owned preload markers separating process entry and the first event-loop
turn. Only anonymous counts and timings are retained. The acceptance readiness window matches
the production CLI's 45 seconds and bounds stalled probes.
`node --test scripts/acceptance/schema/check-startup-evidence.mjs` compares a controlled slow
start with the production launcher and verifies timeout/exit failure sensitivity.
Append `client` to rerun a diagnosed client failure independently; this does not replace the
full cycle record. Append `2.5.5` or `1.23.2` for an isolated User-Agent build experiment, or
`production` for a transient backup-endpoint-only experiment. These modes identify themselves
in the result and do not alter production routing, version selection or saved configuration.

`node scripts/acceptance/schema/run-live-retry.mjs <network|rotation|incomplete|all> [gemini-3.7-flash-high|gemini-3.1-pro-high]`
starts the prepared core with a temporary loopback relay. Network mode resets the first
controlled continuation connection; rotation mode returns 503 for both addresses on the
first account. Successful generations use the real provider. Incomplete mode injects a
disclosed thought-only unary fragment on the initial tool request, then requires a real
streamed tool turn and all result continuations. It never supplies successful tool calls.
The gate correlates audit attempts within one gateway request, compares preserved contents,
excludes private identities and requires stopped-state restoration with unchanged saved
settings. Natural rate limits or other extra attempts keep the strict scenario failing.
Network/rotation modes provide supplementary fault coverage; default-primary tool/result
acceptance does not require a successful backup-endpoint probe. See the
local scope record (`artifacts/schema-work-package/retry-verification.md#acceptance-scope`).
`node --test scripts/acceptance/schema/check-retry-evidence.mjs` checks injection, forwarding,
audit discrimination and privacy sensitivity using isolated fixtures.

`node scripts/acceptance/schema/verify-remote-event.mjs <event-id> <test-release>` reads the exact
remote event and emits only closed diagnostic fields and privacy booleans. A nonempty stored
user context keeps the strict privacy check failing even when receipt is confirmed. See the
[security reference](../../security/diagnostics.md#schema-diagnostics-and-node-reporting).

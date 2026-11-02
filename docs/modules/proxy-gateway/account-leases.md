# Proxy Account Leases

The proxy gateway selects managed accounts for API requests through account leases. Lease token
refresh and project resolution use an in-memory cache so the request that acquired the lease can
continue without waiting for SQLite persistence.

## Token and project persistence

Refreshed access-token and resolved project-ID state is applied to the cache before durable
persistence. Persistence is deferred to the next event-loop turn and serialized per account, so an
older write cannot overtake a newer token or project update. Different accounts persist
independently.

A deferred write failure is logged without invalidating the lease that already succeeded. Graceful
gateway shutdown drains queued writes. An abrupt process exit can lose the latest deferred update.
Account mutations outside this lease path keep their existing awaited persistence behavior.

## Targeted account leases

Requests can bypass automatic pool scheduling and pin a specific account using the
`x-antigravity-account-id` or `x-account-id` request header. When supplied, `AccountLeaseService`
matches the target by account ID or case-insensitive email, hydrates that account's token
directly, and verifies model compatibility and validation status. If the target account is
unavailable, depleted or blocked, the request fails without falling back to other pool accounts.
Targeted leases retain exclusion, account cooldown and model rate-limit checks. Image leases
pin the same target while waiting for its scheduler capacity; another account is never substituted.
Responses emit `x-antigravity-account-id` and `x-antigravity-account-email` headers reflecting
the serving account.

## Playground execution

The Playground aggregates the gateway's streaming Chat Completions endpoint. Execution follows the
selected gateway owner: embedded mode runs locally, while standalone mode delegates through
private core RPC. The core reads its own gateway state and API key; credentials do not cross the
control transport. Remote transport failures never fall back to the embedded gateway.
Playground RPC accepts up to 256 KiB of encoded request data and 16 MiB of response data, including
UTF-8 prompt text, per-account request snapshots and RPC envelopes; other RPC methods retain their
existing limits. Oversized responses fail explicitly. Generation uses the owner's configured
request timeout rather than the short status-read timeout. Core shutdown closes admission and drains
already admitted Playground requests before releasing the profile.

Aggregation requires the terminal `[DONE]` event and retains at most 8 MiB of stream data per
request. Invalid events and truncated streams are reported as failures rather than successful
empty responses. Timings distinguish response headers, upstream first byte, first reasoning and
first visible text. Generation speed uses the first and last observed deltas; missing measurements
remain unmeasured rather than falling back to end-to-end speed.
Requests accept cancellation through the typed IPC call. Stopping Dual Models
or Benchmark, or leaving either tab, cancels its pending calls and prevents stale results from
changing a later run. Benchmark also cancels its jitter timer and dispatches no further probes.
Cancellation cannot recover quota already consumed by an upstream request.

Multi-account comparison starts with no selected accounts. Users can select up to eight accounts;
Select all selects the first eight. The IPC schema and comparison service enforce the same account
limit. Selected accounts execute with at most four requests in flight, and results retain the
selection order. Request and response byte limits and the owner's generation timeout still apply.
The initial model is taken from the displayed model catalog rather than a separate hardcoded ID.
The visible-model filter applies to each Playground mode. An empty filtered catalog disables
execution; changing visibility removes hidden models from the effective selection.

Benchmark runs one to five probes per selected model, with three by default. Each completed sample
updates the report immediately. Stop retains those samples and their statistics while cancelling
the pending probe and skipping unstarted models. Medians use measured successful samples; p95
requires at least three measurements for that metric.

Starting the gateway from Playground uses the same first-use account-risk acknowledgement as
API Proxy. A returned start failure remains a failure, including an occupied port.

Copy cURL preserves the submitted model, prompt, system prompt, temperature, token limit and
reasoning settings and pins the serving account when known. It emits a POSIX-shell command with
an API-key placeholder, never the configured credential. Benchmark Markdown exports describe the
account captured at run start even if the selector changes after completion. The table and export
use the final completed sample for HTTP status and token counts, including failed samples. Missing
token measurements appear as `-`; sample counts retain both successful and failed attempts.

## Related references

- [Proxy compatibility](compatibility.md) describes account scheduling and stream completion.
- [Architecture](../../architecture.md#desktop-embedded-proxy-gateway) describes gateway ownership
  and lifecycle.
- [Cloud account module](../cloud-account/overview.md) describes the managed account pool and
  credentials stored in the local profile.

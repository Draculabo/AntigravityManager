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

The Playground uses the gateway's non-streaming Chat Completions endpoint. Execution follows the
selected gateway owner: embedded mode runs locally, while standalone mode delegates through
private core RPC. The core reads its own gateway state and API key; credentials do not cross the
control transport. Remote transport failures never fall back to the embedded gateway.
Playground RPC accepts up to 256 KiB of encoded request data and 16 MiB of response data, including
UTF-8 prompt text, per-account request snapshots and RPC envelopes; other RPC methods retain their
existing limits. Oversized responses fail explicitly. Generation uses the owner's configured
request timeout rather than the short status-read timeout. Core shutdown closes admission and drains
already admitted Playground requests before releasing the profile.

Invalid completion payloads are reported as failures rather than successful empty responses.
Requests accept cancellation through the typed IPC call. Stopping Dual Models
or Benchmark, or leaving either tab, cancels its pending calls and prevents stale results from
changing a later run. Benchmark also cancels its jitter timer and dispatches no further probes.
Cancellation cannot recover quota already consumed by an upstream request.

Multi-account comparison starts with no selected accounts. Users can select individual accounts
or all listed accounts; there is no account-count cap in the UI or IPC schema. The count displays
the current selection, and execution remains disabled until at least one account is selected.
Selected accounts execute concurrently; request and response byte limits and the owner's
generation timeout still apply.
The initial model is taken from the displayed model catalog rather than a separate hardcoded ID.

Starting the gateway from Playground uses the same first-use account-risk acknowledgement as
API Proxy. A returned start failure remains a failure, including an occupied port.

Copy cURL preserves the submitted model, prompt, system prompt, temperature, token limit and
reasoning settings and pins the serving account when known. It emits a POSIX-shell command with
an API-key placeholder, never the configured credential. Benchmark Markdown exports describe the
account captured at run start even if the selector changes after completion.

## Related references

- [Proxy compatibility](compatibility.md) describes account scheduling and stream completion.
- [Architecture](../../architecture.md#desktop-embedded-proxy-gateway) describes gateway ownership
  and lifecycle.
- [Cloud account module](../cloud-account/overview.md) describes the managed account pool and
  credentials stored in the local profile.

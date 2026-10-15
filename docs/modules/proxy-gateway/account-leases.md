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

## Related references

- [Proxy compatibility](compatibility.md) describes account scheduling and stream completion.
- [Architecture](../../architecture.md#desktop-embedded-proxy-gateway) describes gateway ownership
  and lifecycle.
- [Cloud account module](../cloud-account/overview.md) describes the managed account pool and
  credentials stored in the local profile.

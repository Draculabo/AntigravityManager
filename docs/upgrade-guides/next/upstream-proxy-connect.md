# Upgrade guide: Allow CONNECT on gateway upstream proxies

Target version: next

## Affected users

Gateway operators routing Gemini upstream requests through an HTTP(S) proxy, including
operators using a custom upstream endpoint with an explicit destination port.

## Required action

Allow HTTP CONNECT from the configured account, application or environment proxy to the
upstream host and port. A proxy that only supports absolute-form forwarding can reject
the gateway request after upgrading. Check the proxy's CONNECT policy if the gateway
reports a proxy rejection or tunnel timeout.

The gateway now reuses connections in a bounded pool. Each proxy identity admits 20 active
physical requests, including open streams, and the client retains up to 16 proxy identities.
When those limits are busy, a new request receives HTTP 503 before any provider attempt.
Retry after active work completes. Idle identities are evicted to admit a new identity.

## Data and recovery

The proxy URL format and stored credentials are compatible with this upgrade. HTTPS
origin traffic remains encrypted through the tunnel. An HTTP custom upstream still uses
plaintext inside the tunnel.

## Downgrade

No data migration is required. An older gateway can send origin authorization directly
to the proxy when it uses absolute-form forwarding. Use a proxy that you trust with the
origin credentials if you revert to that behavior.

## Verification

Loopback fixtures verify credential separation, proxy rejection, CONNECT timeout and
stream cancellation. See the [proxy compatibility reference](../../modules/proxy-gateway/compatibility.md).

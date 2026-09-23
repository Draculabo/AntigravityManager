# Antigravity Manager Context

Antigravity Manager coordinates local Antigravity installations, cloud accounts, proxy gateway traffic, identity profiles, and local persistence. This vocabulary names the project-specific concepts that should shape module seams.

## Language

**Antigravity App Target**:
One concrete local Antigravity installation that can receive account state or runtime configuration. A target is usually `classic`, `ide`, or `agy`.
_Avoid_: app type, runtime kind, editor variant

**Cloud Account**:
A stored external account with tokens, quota state, optional proxy configuration, and optional identity-profile binding. A cloud account can be used by local switching flows and by the proxy gateway.
_Avoid_: user, credential row, token record

**Account Token**:
The OAuth token state attached to a cloud account, including access token, refresh token, expiry, client key, project ID, and upstream proxy URL.
_Avoid_: auth blob, credential payload

**Account Lease**:
A short-lived selection result that gives the proxy gateway one cloud account ready for an upstream model request. The lease includes selection, cooldown, quota, refresh, and project-ID readiness decisions.
_Avoid_: selected token, next account, token pick

**Quota Snapshot**:
The latest known usage and reset state for a cloud account and its models. A snapshot can come from cached account state or a realtime upstream fetch.
_Avoid_: quota JSON, limits object

**Proxy Gateway**:
The local server module that accepts OpenAI, Anthropic, and Gemini-shaped requests and forwards them to the upstream Antigravity/Gemini path.
_Avoid_: proxy server, gateway service

**Gateway Request**:
One incoming request accepted by the proxy gateway before protocol conversion and upstream execution.
_Avoid_: API request, chat call

**Upstream Model Request**:
The request shape sent from the proxy gateway toward the upstream model provider after protocol conversion, model mapping, and account lease resolution.
_Avoid_: Gemini request, internal request

**Credential-Store Injection**:
Writing cloud account token state into the Antigravity credential store format expected by a specific app target.
_Avoid_: token restore, credential sync

**IDE Account Import**:
Reading existing account state from an Antigravity IDE database or credential store and converting it into a cloud account.
_Avoid_: sync from IDE, account backup

**Device Profile**:
The local identity payload used to make an Antigravity app target present a stable machine identity.
_Avoid_: machine info, fingerprint

## Flagged Ambiguities

**Account** currently means both local account snapshots and cloud accounts. Use **Cloud Account** for OAuth-backed accounts and **Antigravity App Target** when referring to the local installation being switched.

Use **Account Lease** for proxy account selection and readiness. Token refresh is only one part of the lease decision.

## Example Dialogue

Dev: The proxy gateway needs an account before sending an upstream model request.

Domain expert: Ask the account lease module for a lease. It should hide quota snapshot checks, token refresh, cooldown, project-ID readiness, and sticky-session selection.

Dev: After the user switches accounts in the UI, should the proxy gateway also update the credential store?

Domain expert: No. Credential-store injection belongs to the cloud account switching flow for an Antigravity app target. The proxy gateway only needs an account lease.

# Agent Note: Quota Summary Hub Identity

Status: implemented

Partially superseded by: [Classified metadata failover](2026-11-05-metadata-error-policy.md)
for error traversal and project removal. Identity, group matching and historical live
acceptance below remain active.

## Problem

Google AI Pro accounts have a separate weekly Gemini 4 Argon limit that the Antigravity app shows
as a third quota-summary group, but Manager stored only the Gemini and Claude/GPT groups. Stored
snapshots for several AI Pro accounts contained no Argon group, so the renderer was not dropping it.
Two request differences explain the gap. The app starts its language server with
`--subclient_type hub` and the Daily Cloud Code endpoint, while Manager asked the sandbox host
first with the bare `antigravity/<version> <os>/<arch>` identity. Public comparisons that reuse one
OAuth token report that the bare identity at a current version receives only two groups on Daily,
while `hub` and `cli` identities above a minimum version also receive the Argon group, and that
production returns two groups even to `hub`. Manager also ended the summary lookup on the first
non-429 4xx, so an account whose sandbox summary returned 403 lost every group without trying
another host.

## Decision

`GoogleAPIService.fetchQuotaSummary` sends `antigravity/hub/<version> (aidev_client; os_type=<os>;
arch=<arch>)`, using the installed Antigravity version when the version cache holds a newer one and
`HUB_CLIENT_MIN_VERSION` otherwise. It queries Daily, Sandbox, then Prod under the confirmed
internal endpoint preference. The original Daily-first live identity evidence below is
retained; it does not independently establish the reordered fallback hosts. Network errors and
HTTP 408/429/5xx permit the next host. Permanent rejections end this optional lookup.
Project removal requires the structured, matching consumer denial described in the replacement
decision and remains removed across hosts and from primary quota into summary. Model quota is
returned when optional enrichment fails.

Other Cloud Code requests keep the existing identity. A quota-summary group whose display name is
exactly a registered model-family name is dedicated to that family. Its display name and bucket ID
also contain the provider name, so provider tokens such as `gemini` no longer match it: token
matching and automatic switching apply it only to models of that family, and weekly warmup skips
it unless the representative warmup model belongs to that family.

## Alternatives considered

- Reordering hosts without changing the identity would still receive two groups on Daily,
  according to the public comparisons; the live check changed host order and identity together.
- The original change rejected keeping HTTP 400 terminal, as the
  [project-context lookup](../architecture/2026-09-16-project-context-fallback-and-reset-time.md)
  does, for the summary. The three hosts are separate deployments, host-specific
  400 responses such as sandbox location restrictions have been reported, and a failed summary
  only removes optional grouped quota, so the bounded extra requests cannot hide a failed model
  quota lookup. The 2026-11-05 partial replacement restores the original D10 terminal policy;
  these reports do not establish recovery permission for arbitrary permanent rejection.
- Sending the hub identity on `fetchAvailableModels` and generation would also expose
  `gemini-4-argon-*` models. That changes proxy model routing and generation identity, which need
  their own compatibility evidence, so it is out of scope here.
- Adding the official client's build changelist and authentication-mode fields to the identity was
  not selected; the values are build- and account-specific, and public evidence shows the shorter
  form receives the group.
- Matching Argon by its bucket ID or the word "argon" would special-case one product; the family
  registry already owns product names.

## Consequences

AI Pro cards show "Gemini 4 Argon" in the weekly section (Weekly and Both windows). Its only bucket
is weekly, so the five-hour Detailed quota section omits it. Google's group description says Ultra
plans include Argon in the larger Gemini bucket; Ultra responses have not been observed. When every
host transiently rejects the summary, traversal remains bounded by the shared deadline. The
replacement policy allows at most one identified project downgrade across the logical refresh.
An exhausted Argon week no longer lowers Gemini Flash or Pro scores,
recommendations or depletion checks, and warmup never spends a Flash request on the Argon bucket.
Google gates groups server-side, so a future minimum-version change requires raising
`HUB_CLIENT_MIN_VERSION`.

## Verification

Unit tests cover the summary identity and Daily-first order, classified project retries,
terminal permanent errors, transient exhausted hosts, the version floor, dedicated-group token matching,
automatic switching, Flash recommendations and warmup selection. Each new behavior test fails
against the previous implementation. Live AI Pro acceptance passed on 2026-10-24 on Windows x64:
after refreshing an AI Pro account in the patched build, the account card's weekly section showed
the Gemini 4 Argon group. Ultra accounts and macOS and Linux clients were not exercised.

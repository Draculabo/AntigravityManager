# Agent Note: Quota Summary Hub Identity

Status: implemented

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
`HUB_CLIENT_MIN_VERSION` otherwise. It queries Daily, production, then sandbox. A 403 sent with a
project is retried once on the same host without it; every other rejection except HTTP 401 moves
straight to the next host. The summary remains optional enrichment, so model quota is returned when
every host fails.

Other Cloud Code requests keep the existing identity. A quota-summary group whose display name is
exactly a registered model-family name is dedicated to that family. Its display name and bucket ID
also contain the provider name, so provider tokens such as `gemini` no longer match it: token
matching and automatic switching apply it only to models of that family, and weekly warmup skips
it unless the representative warmup model belongs to that family.

## Alternatives considered

- Reordering hosts without changing the identity would still receive two groups on Daily,
  according to the public comparisons; the live check changed host order and identity together.
- Keeping HTTP 400 terminal, as the
  [project-context lookup](../architecture/2026-09-16-project-context-fallback-and-reset-time.md)
  does, was not selected for the summary. The three hosts are separate deployments, host-specific
  400 responses such as sandbox location restrictions have been reported, and a failed summary
  only removes optional grouped quota, so the bounded extra requests cannot hide a failed model
  quota lookup.
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
host rejects the summary, a refresh issues up to six summary requests, two per host, instead of
ending at the first host. An exhausted Argon week no longer lowers Gemini Flash or Pro scores,
recommendations or depletion checks, and warmup never spends a Flash request on the Argon bucket.
Google gates groups server-side, so a future minimum-version change requires raising
`HUB_CLIENT_MIN_VERSION`.

## Verification

Unit tests cover the summary identity and Daily-first order, fall-through after same-host 403
retries, the terminal 401, exhausted hosts, the version floor, dedicated-group token matching,
automatic switching, Flash recommendations and warmup selection. Each new behavior test fails
against the previous implementation. Live AI Pro acceptance passed on 2026-10-24 on Windows x64:
after refreshing an AI Pro account in the patched build, the account card's weekly section showed
the Gemini 4 Argon group. Ultra accounts and macOS and Linux clients were not exercised.

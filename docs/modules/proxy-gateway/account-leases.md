# Proxy Account Leases

The proxy gateway selects managed accounts for API requests through account leases. Lease token
refresh and project resolution use an in-memory cache. Bounded quota recovery and
request-owned image hydration await guarded credential persistence before publishing
a renewed token; the existing uncontrolled hydration path keeps background persistence.

## Account-cache load publication

Only the latest requested account load may publish its stored snapshot. A newer
load invalidates older reads even when it fails; the previously published pool
remains usable. Accepted eviction also invalidates reads already in flight,
including eviction from an empty cache. A rejected conditional OAuth eviction
changes neither the cache nor its load generation.

Each read captures current cache-entry identities and shallow token state. Entry
replacement, scalar credential/project changes or owned health replacement while
the read is pending invalidate that read. Nested quota/health values retain their
existing replacement owners. The repository owns durable row incarnations; the
cache guard does not make arbitrary in-place nested mutations safe.

A valid snapshot is fully converted before the live token map is replaced.
Superseded reads do not apply forwarding snapshots. Ordinary loading logs a failed
or superseded read and returns zero; strict reload rejects it with the internal
load-superseded error. Rejected strict reloads do not run session/rate-limit reset
effects. No automatic reload retry, global lock release or permanent account
tombstone is added. A fresh load can admit a new stored account after eviction.

Desktop and standalone-core deletion use the shared cloud-account deletion owner,
which commits durable deletion before invoking gateway cleanup. Cache eviction alone
is still distinct from durable deletion and account disablement.

## Independent quota windows

Lease quota projection preserves fractional precision. Group constraints keep their
raw source buckets; the effective model value is derived. A weekly/7d fraction at
or below 0.001 is depleted; a five-hour window requires actual zero. Multiple
depleted windows block through the latest parsed reset instant. A later reset on
a non-depleted window does not extend that deadline. Route waiting also checks
group-window protection independently of temporary model locks.

Realtime refresh retains omitted active windows before persistence and cache
publication. Only matching fresh window evidence can clear previously observed
protection; another model/group or an incomplete summary cannot recover it.
Account-wide recovery additionally checks previously known model coverage. D01's
incarnation, token, completion and quota-observation fences still govern publication.

The existing summary supplies labels/bucket IDs but no authoritative model-membership
IDs. Specific recognized Claude family labels stay separate; explicitly shared
Claude/GPT or 3p labels retain shared protection. Unknown memberships are not guessed.
Bucket matching normalizes weekly/7d aliases while preserving exact bucket IDs.
Recovery cannot use an older or timestamp-free bucket over a known observation;
the raw fresh response is checked before retained data is merged. Successful API
observations and additive storage behavior are defined in the
[cloud-account reference](../cloud-account/overview.md#quota-observation-ordering).
Ordinary lease selection treats expired depleted windows as requiring revalidation.
An available account is used immediately; otherwise one eligible expired account
may receive a quota lookup within the original selection/request deadline, capped
at two seconds. Zero wait budget, exclusions, OAuth quarantine, validation, cooldown
and active hard/rate locks prevent admission. Concurrent requests do not queue on
that lookup. The same cache entry waits at least 30 seconds between attempts and
remains single-flight until an uncooperative provider adapter actually settles.

Before quota lookup, hydration renews tokens within five minutes of expiry and
persists the credential snapshot under the existing account/credential guards.
Renewal, owned project discovery and quota lookup share the same two-second cap;
none receives a renewed deadline. Cancellation, a new lock or a missing stored account
stops publication and dependent lookup. Failed or uncertain credential persistence
evicts the unchanged cache context so the next load uses durable state. A committed
token write is retained; remote grant rotation cannot be rolled back or inferred
from a timeout. Existing finite OAuth invalid-grant retry/client fallback stays within
this budget. No generation or tool replay is added.

Complete matching windows must have current reset deadlines; incomplete
or expired responses retain prior evidence. Fresh zero still blocks. Cancellation,
deletion, shutdown, newly imposed locks and the absolute deadline fence publication.
Google project discovery, model lookup, summary and fallback delays share the abort
signal. An already committed valid storage write is not rolled back by later cancellation.

Image acquisition uses the same recovery owner before taking a concurrency permit.
One probe allowance and one selection-wait budget span all busy-account reselections
and capacity wakeups. The whole image queue uses the earlier of its configured
timeout and caller deadline, including credential/project preparation. Caller abort,
shutdown and deadline expiry stop waiting even when an adapter ignores cancellation;
late results remain fenced. A permit acquired across cancellation is released.
An independently owned project probe retains its own lifetime when another caller
joins it; cancellation of the joining caller does not revoke other callers' work.

Final D08 identity integration, freshness/reason UI, subscription and official-cycle
accounting remain work. These checks are not live-provider acceptance.

## Weekly quota expiry preference

The API Proxy scheduling settings expose an optional weekly-quota expiry preference,
disabled by default. It changes allocation of unbound requests, including requests
without a session key. An existing valid session binding suppresses this preference
even when its account needs the normal failure fallback. Explicit preferred-account
selection retains its existing precedence.

Only provider-declared group/model membership for the account's resolved physical
model can establish a candidate. A weekly bucket must have positive, non-depleted
remaining quota and an unambiguous reset instant in the next 24 hours. Missing,
invalid, expired or conflicting weekly observations do not promote an account.
Historical group-label guesses remain available to existing protection logic but
cannot establish this optimization.

After existing eligibility and lock checks, the earliest reset group wins before
manual priority. Equal reset deadlines use existing manual priority and selection
behavior. In account-first mode this preference precedes model-level retained affinity
for a new session; model affinity is not an existing session binding. Existing quota
weighting and hard depletion gates retain their owners.

The preference is projected for each selection, including after a completed wait.
No saved account priority is overwritten and no other account is disabled. Depletion,
cycle expiry or a disabled switch removes the temporary preference on subsequent
selection. The user option remains saved until disabled; a later eligible cycle can
qualify again. Quota recovery still requires the existing fresh evidence. This mode
dispatches no probes or generated requests of its own and provides no additional
quota. The settings owner's save/application results distinguish saved configuration
from runtime application.

## Deleted-account cleanup

Deletion invalidates in-flight cache loads, refresh/project results and pending
affinity commits for the removed entry. It releases that account's session/model
affinity, image-scheduler membership, cooldown, model/global rate locks, failure
counters and runtime preferred-account reference. The deletion owner also clears
the matching saved preference through the configuration queue, preserving a newer
choice or recreated account. Other accounts retain their state.
OAuth quarantine continues to use a narrower eviction that preserves quota and
capability protection.

Capability/rate availability cleanup also saves the retained snapshot in the
existing settings row, including while the gateway is stopped. Strict cleanup
propagates read, validation and write failures. An unreadable initial snapshot
cannot be replaced with an empty default; ordinary proxy use keeps its logged,
best-effort behavior and suppresses persistence until hydration succeeds. An
explicit deletion retry can retry hydration and saving, without a provider request.

The durable account row and active-client references share their existing SQLite
transaction. Gateway cleanup follows that commit and is not rolled back if cleanup
fails. The live account is evicted before availability persistence; failure reports
that deletion committed but cleanup is incomplete, retaining the original cause.
The caller can explicitly retry deletion. No automatic replay is introduced.
Standalone deletion participates in existing mutation admission and shutdown drain.

Realtime quota probes capture the selected cache entry and credential context.
Eviction, entry replacement or a context change prevents an old result from
dispatching a quota write or publishing cache/forwarding/lock effects. The guard is
checked again after an awaited store write. A stale failed probe cannot fall back
to recreating a rate-limit lock. Token, quota and validation writes also carry a
synchronous repository guard into their SQLite mutation or queued health owner.
Changing the stored identity, complete token or proxy rejects an old lease write
even before the cache reloads the replacement.

Loaded entries keep a private identity/token baseline; queued token writes advance
only their own baseline after a successful guarded write. Refresh and project writes
can therefore complete in order without adopting an external writer's token. This
baseline is never part of returned protocol credentials or a new durable format.
A baseline advance also invalidates an older cache load. Validation persistence
checks the selected entry before publishing its deadline or clearing sessions.
Background persistence keeps its existing diagnostic error and drain policy;
already dispatched provider work is not cancelled or retried.

Manual quota and monitor token/quota/status writes use
[guarded refresh writeback](../cloud-account/overview.md#oauth-refresh-ownership).
Stored incarnation checks reject same-value deletion/recreation. Independent
quota-result ordering across background/manual owners remains a D01-R12 obligation. Google enrollment has
[guarded follow-up](../cloud-account/overview.md#google-enrollment-follow-up). Import transactions have
[their own snapshot guards](../cloud-account/overview.md#import-commit-ownership). Cleanup does not cancel
already dispatched provider work.

## Late request errors

OpenAI, Anthropic, Gemini and token-count execution retain the issued lease's
ownership check through error handling. Image retry preparation uses the same
check. It compares the live entry, captured credential/client/proxy context and
the current stored token/incarnation, including before cache reload observes a
replacement. Stale or unrecognized leases cannot add cooldowns, capability records,
quota locks or validation state to the current account. Request-local reporting
retains the original failure; suppressing account effects does not report success.

Checks follow quota/health waits, before availability persistence, and before
publishing a grace retry after waiting. Loss of image ownership releases its permit.
An ownership-read failure records a diagnostic and suppresses account effects;
missing proof does not authorize penalties. Provider retry budgets are unchanged.
Accepted effects already committed and cross-owner gaps after a final check remain
separate lifecycle obligations.

## Late successful responses

Success cleanup carries the original issued lease through OpenAI Chat, Responses,
Anthropic, Gemini, token counting and image-stream completion callbacks. It uses
the same current-entry and stored-context proof as error handling before clearing
cooldowns, quota/rate locks or capability observations. Session commits also check
ownership, including when storage has changed before cache reload sees it.

An old response still returns its generated output; it cannot clear a replacement
account's protection or establish new affinity. Missing ownership proof suppresses
these account effects. Existing non-image stream acceptance timing and image
clean-end conditions remain unchanged. Current issued leases retain normal cleanup.
Concurrent request effects follow the completion fence below; already accepted
effects are not retrospectively reversed.

## Request completion order and eligibility

Each cache entry numbers its issued leases. Accepting a success/error completion
advances an account-wide fence: a lower-numbered lease cannot subsequently mutate
request protection or commit affinity. Merely issuing a newer lease does not move
the fence. The scope spans models because successful cleanup can release global
account locks; an older model-specific observation may consequently be suppressed
after another model's newer completion. Generated output and request errors remain
independent of these state effects. Stream success timing remains unchanged.

The counters use weak ownership and disappear with their entry; they are not stored
in SQLite and do not retain account tombstones. Cache replacement continues to
invalidate earlier entry ownership. Retried work that obtains a fresh lease receives
a fresh issue number; stale grace retries cannot revive an earlier one.

Issuance, success cleanup, affinity and grace retry check current eligibility.
OAuth refresh blocks and active validation quarantine are checked both in cache
and, where the production adapter supplies proof, in current storage. Observed
ineligibility fences outstanding leases, including after recovery. A new lease can
be issued after recovery or the validation probe deadline. Diagnostic account status
labels do not become new hard selection gates.

A newly observed zero-percent quota with a future reset in the physical model's
quota family prevents stale-cache issuance and success cleanup. The comparison is
against that entry's observed quota. Already-loaded quota scheduling, expired or
missing deadlines and independent model families retain their existing policy.

Error-driven quota reconciliation carries its originating completion check through
the provider wait, guarded SQLite write and cache publication. Lease token/project
and validation writes also reject persisted OAuth/validation ineligibility at commit.
A qualification change after a quota commit stops later cache publication without
pretending that the committed quota was rolled back. Restrictive error reporting
remains separate from permission to recover an account.

Manual, monitor, enrollment and warmup quota observations do not share this gateway
completion clock. Their mutual ordering remains separate D01 work. An external
eligibility change and reversal that no owner or guard observes is not fenced by
this process-local policy. Effects after the last synchronous check retain their
existing cross-owner limits.

## Stable selection and initial recovery

All selection strategies exclude a finite target-model quota at or below zero
before priority, preferred-account or session selection. The quota reader resolves
the account's physical model first. Missing or non-finite quota stays unknown and
does not become zero. Quota weighting may be disabled without disabling this gate.
Retry alternative counts and retry waits apply the same depletion rule. Expired
depleted windows still enter the existing bounded quota-revalidation flow before
selection; an eligible fresh quota snapshot can admit the account again. Recovery
checks do not mistake a known-zero alternative for an immediately usable account.

Candidate account IDs use binary ascending order before selection. Reloading the
same pool in a different storage order does not change its rotation sequence.
Balanced selection retains its target-model quota weights and round-robin cursor;
account-first retains successful affinity. Existing preferred-account and session
precedence remains intact. Account priority fields remain a separate D18 obligation;
this does not introduce subscription-tier or health-score ranking.

An empty eligible pool can wait once for the shortest remaining transient lock or
account cooldown, when it is at most two seconds and fits the selection budget.
Parity cache-first can instead wait for its eligible session account within the
same budget. Selection never clears locks. After a completed wait it reads current
locks, cooldowns, account-entry identity, OAuth/validation eligibility, model
capability and target-model quota again. A still-blocked or replaced pool returns
no candidate; the caller retains its existing unavailable/error contract.

The initial-selection wait deadline is shared across credential-refresh failover
within one lease acquisition. Ordinary generation and token-count retry owners
also supply their existing request deadline and abort signal. An unaffordable wait
does not register a timer. Cancellation settles waiting and removes its timer and
abort listener; it cannot publish a pending lease. Later retry selections continue
to disable selector waits, leaving their separate bounded retry owner in control.
The selection-wait budget bounds transient-lock waiting. Bounded quota recovery
also caps preparation and lookup; the separate image queue owner caps its whole
acquisition. Ordinary hydration without an owned signal retains its existing
provider timeout. Complete account-deletion and in-flight cleanup remain D01-R12 work.

## Successful account affinity

When the winning session hint is the `x-session-id` header and a credential is
present, `root:step:1` uses `root` for account selection. The root accepts ASCII
letters, digits, underscores and hyphens. Other suffixes, anonymous requests and
restored Responses lineages use their original affinity. Sibling steps and their
root can share a selected account within one credential scope. Each child keeps
its original audit identity, history and signature-cache keys.

Selection and hydration return a pending account. They do not publish a session
binding or replace the account retained by account-first scheduling. Ordinary
generation commits affinity when its upstream response succeeds; streaming commits
when the protocol operation establishes the upstream stream, before consuming its
events. A later stream error terminates that stream without undoing the binding
or replaying the request. The session TTL starts at commit and lasts ten minutes.

Token counting commits after validating the returned count. Diagnostic v1internal
passthrough commits only after a successful HTTP status. Native Gemini operations
without a session key do not invent conversation affinity; account-first retention
still commits on their successful response. Image permits, retry ceilings, quota
success rules and stream completion checks retain their separate owners.

A failed account attempt can remove only the session and model-retention records
it observed before selection. A newer success, including one on the same account,
creates a different record and survives that older failure. HTTP 401/403/429/5xx
and classified retryable transport failures abandon the observed affinity. A
request-validation HTTP 400 does not imply an unhealthy account. Grace can commit
the same pending lease after its earlier failure; repeated success callbacks are
idempotent and cannot overwrite a newer successful binding.

Pending state is held in a weak map owned by the lease service and is not exposed
in protocol payloads or persisted. Commit checks that the selected cache entry is
still current and is not OAuth-disabled or validation-blocked. Clearing sessions
invalidates pending commits; deleting and reloading an account does not permit an
old lease to recreate its binding. Cancellation observed before commit leaves
affinity unpublished. Credential hydration and persistence keep their own lifecycle
and are not rolled back by an uncommitted or failed affinity attempt.

## Account-specific model failures

Explicit upstream model-not-supported or model-access-denied evidence creates a
900-second capability avoidance record for the failing account and known model
family. The same shared availability owner is used by retry penalties and lease
selection. The old process-wide, permanent rejected-model set is removed. A
different account can serve the model, and another family on the failing account
remains eligible.

Status alone is insufficient: ambiguous 404, project/endpoint failures, credentials,
validation, network-policy restrictions and tool/Schema parameter errors do not
establish model incapability. Structured model reasons take precedence where they
name the current model or the upstream operation already supplies that context.
Text recognition requires the physical model name and an explicit rejection.
Existing account-health, quota and transport policies continue to handle other errors.

Active capability records are enforced even when an account's model catalog is
unknown or filtering leaves no supported model. Existing safe sibling routing can
use a candidate advertised by that same account; rejected candidates are filtered
from forwarding, display-preset and dynamic-model resolution. An exact available
model on another account retains the selection preference. Known parameter recipes
still constrain physical rebinding.

Tiered variants of the same known family share entitlement evidence. For example,
a denial for `gemini-3.7-flash-low` also avoids its `medium` and `high` physical
tiers on that account. Image families keep their own identities, so success for
`gemini-3.1-pro-image` does not clear a denial for `gemini-3-pro-image`.

The record expires at its original deadline and can survive ordinary account-cache
reload and process restart in the existing availability format. A fresh quota or
catalog response alone does not prove generation support and cannot clear it.
Actual success clears the corresponding capability record; image-family temporary
quota/rate cleanup does not clear a different physical model's capability denial.

The account model catalog separates advertised model metadata from request
eligibility. Raw discovery exposes physical quota IDs, while the public directory
may project known provider display names. The union across loaded accounts is
informational and is not evidence that every individual account can invoke every
listed model. A bare model's effort participates in account selection and
physical resolution; malformed effort fails before selection.

This implementation uses known model-family identity within the existing Google
gateway. Independent upstream-entry identities and an authoritative per-account
positive catalog remain open. Complete deletion/in-flight account lifecycle
guarantees remain D01-R12 work.

## Project discovery failures

Project discovery coalesces concurrent requests for the same live account entry and
credential context. An unavailable, invalid or rejected result is cached in memory
for 300 seconds from failure settlement. Cache hits do not extend the interval.
After expiry, the next request probes again; a valid known project takes precedence
and clears the failed state. Existing provider request timeouts remain unchanged.

During the interval, hydration uses the configured fallback for the current request.
The fallback is not assigned to the cached token or persisted as a discovered project.
The initial provider exception remains in the diagnostic log; cache hits do not make
another provider request or imply successful discovery.

Failure state and in-flight work belong to the exact cache entry, refresh credential,
OAuth client, account email and upstream proxy context. Ordinary access-token rotation
does not invalidate a failed probe. Replacement/reload, credential-context changes,
account eviction and explicit discovery invalidation stop old results from updating
the current account. Old work does not block a replacement entry's probe or recreate
a deleted account. Discovery state uses weak keys and is not persisted.

Project persistence rechecks the discovery context and project value before dispatch
and after the account-store read, before writing. A queued old project update cannot
overwrite a replacement account or a newer known project. Already dispatched writes
retain the account store's existing completion semantics.

## Token and project persistence

Refresh operations belong to the exact live cache entry and its refresh credential,
OAuth client, email and proxy context. Concurrent refreshes in that context share
one pending operation. A replacement entry or changed context starts independently
and does not consume the old operation's result. Old success cannot reinsert a
removed account or overwrite its replacement; an old refresh-blocked failure cannot
delete the replacement. Hydration rechecks its context after refresh and project
discovery, and final selection rechecks current identity and eligibility before
returning a lease. A stale operation fails explicitly rather than returning fallback
credentials. Original typed refresh failures remain attached as diagnostic causes.

Refreshed access-token and resolved project-ID state is applied to the cache before durable
persistence. Persistence is deferred to the next event-loop turn and serialized per account, so an
older write cannot overtake a newer token or project update. Different accounts persist
independently.

A refresh snapshot includes an identity/context guard, also checked after the final
account-store read before dispatching its write. Replacing/removing an entry or
rotating its credential context invalidates queued old writes. Already dispatched
store writes retain the repository's existing completion semantics. Refresh
coalescing uses weak entry keys; outstanding provider work settles normally and
cannot mutate a replacement entry. No new OAuth retry or cancellation is added.

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

The cloud-account refresh owner retains its existing durable two-operation
`invalid_grant` confirmation rule. It also verifies stored credential context before
OAuth health transitions and supplies expected context to synchronous lease-cache
updates/eviction. See [OAuth refresh ownership](../cloud-account/overview.md#oauth-refresh-ownership)
for the contract and its limits. See [deleted-account cleanup](#deleted-account-cleanup)
for deletion entry points, quota probes, failure state and the remaining obligations.

## Quota observation ordering across owners

The gateway's realtime quota probe participates in the cloud-account owner's
[quota observation order](../cloud-account/overview.md#quota-observation-ordering),
alongside manual refresh, monitoring, enrollment and post-warmup probes. A newer
accepted quota observation stops old quota persistence, cache publication and
quota-lock reconciliation even when the token/cache entry is otherwise unchanged.
The SQLite mutation guard and post-write check both enforce this fence. A stale
probe returns `stale`; it cannot become an unavailable-probe fallback penalty.

The request-completion fence still independently governs the triggering lease.
Ordinary generation success/error does not itself advance the shared quota clock.
Committed quota is not rolled back when a later publication check fails.

## Related references

- [Proxy compatibility](compatibility.md) describes account scheduling and stream completion.
- [Architecture](../../architecture.md#desktop-embedded-proxy-gateway) describes gateway ownership
  and lifecycle.
- [Cloud account module](../cloud-account/overview.md) describes the managed account pool and
  credentials stored in the local profile.

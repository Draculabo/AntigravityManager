# Cloud Account Module

The `cloud-account` module owns the managed Google account pool, quota refresh and display,
automatic switching policy, account import, and optional weekly warmup. Its desktop feature
surfaces live under `src/modules/cloud-account/`.

## Local Antigravity CLI sign-in

On the Accounts page, the **Import / Export** menu opens local account discovery, file import,
and account export. **Add Account** starts browser authorization.

Local account import discovers credentials in the selected owner's operating system environment.
An `agy` login in the shared system keyring appears under the system credential source. A login
in `~/.gemini/antigravity-cli/antigravity-oauth-token` appears as **Antigravity CLI saved sign-in**.
Validation and deduplication apply before confirmation. The preview carries source and account
information, while credentials stay with the import owner. A missing CLI file is skipped.
Read and format errors appear in the preview.

When the account list refreshes, a valid dedicated CLI file takes precedence. If that file is
unavailable, Manager checks the system keyring when it detects `agy` and no installed Classic or
IDE client using that store. A credential marks the managed Google account with the uniquely
matching refresh token as active for CLI. An unmatched or ambiguous credential leaves the CLI badge
unset. When Manager cannot attribute a readable credential to the CLI, it uses its last recorded
CLI selection. These reads leave credentials, stored selections and desktop badges unchanged.

## Account pool and quota

Users can add and import Google accounts, refresh account tokens and quota, inspect account
status, and remove accounts from Manager. Removing an account also removes saved current-account
references that point to it; it does not sign that account out of an official client or select a
replacement. Startup cleanup removes stale references without switching clients. Account deletion
and reference cleanup share a SQLite transaction, so cleanup failure rolls back the deletion.
The Accounts page shows quota on each account card.

Account cards always offer a Use dropdown. App, IDE and CLI badges below the email identify the
clients using that account; accounts without an active client show Not in use. Each client tracks
its account independently, so multiple accounts can have usage badges. The dropdown disables only
targets already using that account, or all targets while its switch is pending. Quota refresh
ordering and tier filters do not redefine client usage.

For a manual recommendation, select Classic, IDE, or CLI in the account list. The
recommendation uses the existing quota requirements and ranking and excludes the
account already used by the selected client. An account used by a different client
can still qualify. Applying the recommendation switches the selected client.

Open **Project ID** from a Google account card to view, save, or clear its ID.
**Fetch from Google** uses that account's credentials and network route and replaces
the saved value only when Google returns a usable ID. Clearing allows the gateway to
discover it again during later use. A Project ID edit does not select a different
provider mode or change the account tier. If the account or ID changes concurrently,
the editor reloads the current value and requires a fresh action.

Desktop and standalone-core removal use one deletion service. After the database
commit it evicts the account from the active gateway and clears its owned runtime
and persisted availability state. It also queues removal of a still-matching saved
preferred-account ID. Both cleanup owners are attempted, retaining independent
failures in an aggregate error. A recreated account or newer preference is preserved.
Cleanup failure reports committed deletion; the row is not restored. Inspect the
account list before an explicit retry, which is a new deletion by ID. Standalone
shutdown drains admitted deletion and rejects new
deletion after mutation admission closes. See
[gateway cleanup](../proxy-gateway/account-leases.md#deleted-account-cleanup) for
the exact state cleared and remaining concurrency limits.

Quota views can show five-hour, weekly, or combined windows, with the combined view as the default.
Gemini and Claude visibility is configured independently for each window and applies to normal,
list, compact, and provider-grouped cards. These controls filter presentation only: they do not
change stored quota snapshots, account scores, warmup eligibility, automatic switching, or proxy
account selection. Claude visibility also covers GPT/third-party (`3p`) buckets; unclassified or
shared groups remain visible.

The weekly view includes provider buckets whose `window` or `bucket_id` identifies `week` or `7d`, without
substituting model quota when those buckets are missing. The five-hour view retains non-weekly
detailed buckets.

The account overview separates enabled normal accounts, manually disabled accounts,
confirmed verification/OAuth/access issues and unconfirmed health. Confirmed issues
take precedence over manual disablement in the primary count. Client-current identities
and rate-limit observations are separate counts. Account state details identify the
rows behind the counts. These counts use the current tier filter.

The pool matrix defaults to enabled normal accounts. Its all-normal scope also includes
disabled accounts with confirmed normal health, and an empty enabled pool never falls
back to disabled accounts. Each model family counts an account once. Five-hour and
weekly columns preserve original window percentages; the effective column takes the
minimum across matching model values and all matching valid window restrictions.
Expired reset boundaries are marked for refresh and never release a restriction.
Known zero values remain in each column's displayed denominator. Missing model data
remains unknown rather than establishing unsupported access or contributing zero.

Tier-weighted remaining percentages use Ultra 2, Pro 1.5 and Free 1. Missing or
unrecognized subscription identity is excluded from the weighted denominator and its
exclusion count is visible. This statistic does not represent official capacity,
remaining tokens, request success probability or live gateway callability. Scope
changes affect this presentation only. Existing account sorting and routing keep
their own contracts.

Grouped quota comes from the Cloud Code quota summary. Manager requests it from the Daily host,
then Sandbox, then Prod, advancing on network errors or HTTP 408/429/5xx. Permanent
rejections and malformed successful summaries end optional enrichment while retaining
primary model quota. A structured Google project-consumer denial permits one no-project
retry; that removal persists across hosts and from primary quota into summary. Unknown
403 responses do not grant this retry.
Project-context and primary model-quota lookup use that same internal host order with
their own status/deadline policies. OAuth and public endpoints retain separate routing.
The summary request identifies itself as the Antigravity app's `hub` client, because Google does
not return model-specific groups such as Gemini 4 Argon to the bare client identity; model quota
requests keep the existing client identity. A group named exactly after one registered model family, such as
Gemini 4 Argon on Google AI Pro, limits only that family. It is displayed like any other group
(Gemini 4 Argon has only a weekly bucket, so it appears only in the weekly view), but scores,
recommendations and automatic switching for models of other families ignore it.

## Subscription identity and refresh

Quota refresh identifies subscription separately from project ID caching and model
availability. It checks `paidTier` before `currentTier`, preferring a nonempty ID to
the name on the same object. Nullable optional project/tier fields are normalized to
absence at the Google response boundary, independently of an available tier identity.
Known IDs (`free-tier`, `g1-pro-tier`, `g1-ultra-tier`
and canonical free/pro/ultra values) map to existing lowercase tier labels. A missing
ID permits only exact recognized name aliases; an unknown ID cannot borrow a paid
name or fall through to a lower-priority object. `standard-tier` and unknown IDs use
the free baseline with unrecognized-source evidence. Visible Claude/GPT models are
not evidence of a paid subscription.

`allowedTiers` only corroborates an explicit `free-tier` ID. A default or recommended
paid offer does not establish subscription. A new account with missing authority uses
the free baseline and records that identity is missing; a discovery failure without
prior state remains unknown. These labels do not replace model capability or quota
eligibility checks.

The optional `quota.subscription` JSON field records refresh status, its local
`checked_at`, and the last successful observation: canonical tier, exact bounded
selected ID/name, source, recognized/missing status and local `observed_at`.
Discovery failure preserves the previous tier and observation, marking the refresh
failed without restamping its evidence. A successful project response omitting all
subscription authority also retains prior state as an incomplete refresh. A fresh
explicit free identity or an unknown authoritative ID can replace the previous paid
value. An older subscription check cannot overwrite newer evidence; D01 identity and
completion-order guards still own concurrent account operations.

The existing quota-write merge applies subscription reconciliation independently of
window reconciliation, including inside the storage transaction. A timestamp-free
legacy response cannot overwrite recorded subscription evidence. Existing legacy
tier strings remain readable and can be retained through failure, but are not
backfilled with invented identity sources or times. Identity ID/name fields are
limited to 256 characters at the Google and persisted evidence boundaries; oversized
input is rejected rather than truncated into a known tier.

No SQL migration, credential-location or provider retry change is required. Older
readers can discard optional metadata on rewrite. The renderer receives the tier
label and an allowlisted status/source/time projection; raw selected ID/name evidence
stays private. Complete quota failures retain their existing operation failure path
and do not publish a successful subscription snapshot. Real-provider, packaged
upgrade/downgrade and final UI acceptance remain separate.

The keyboard-focusable tier badge explains the latest recorded refresh status and
identity source, with separate observation and check times. A failed or incomplete
refresh keeps the stored label and reports that the previous record is displayed;
without a previous label it reports that no confirmed tier is available. Unknown
authority and missing authority explain the free baseline. Legacy labels have no
invented source or observation time. These timestamps describe recorded evidence,
not an automatic freshness TTL or proof that a complete quota refresh succeeded.

## Quota evidence in account cards

Detailed non-weekly rows and weekly rows show their own observation time. Compact
weekly bars expose the same information on hover or keyboard focus. Missing times
remain unknown. Reasons distinguish weekly/window exhaustion, missing resets,
elapsed windows requiring recheck, invalid fractions and small positive values that
round to zero. Raw fractions use the same exhaustion helper as account scheduling.

A group restriction summary remains visible when the selected window omits an
exhausted window, provided that family is enabled in at least one display preference.
Fully hidden families remain hidden; controls still affect presentation only. The
summary considers depleted windows independently per group, showing the latest known
future depleted reset. Positive windows do not extend that wait. Expired depletion
requires refresh confirmation rather than implying recovery; unknown resets remain
unknown. This summary describes stored windows, not every runtime cooldown or
account/model eligibility decision. Authoritative group/model membership remains D08
joint work.

Each rendered quota section owns at most one cancellable reset timer, shared by its
rows. It wakes at known reset boundaries, handles distant deadlines and clock rollback,
and cancels on unmount or boundary replacement. It never fetches data, retries a
request, changes a balance or creates a new provider cycle. The UI uses the existing
six languages and local timestamp formatting.

## Current official-cycle usage foundation

The account-owned `weeklyQuotaCycle` helper derives `[reset - 7 days, reset)` only
for a current weekly/7d bucket with a valid offset-bearing reset instant. Invalid,
expired and not-yet-started windows are unavailable; no following cycle is invented.
Reset interpretation is independent of remaining quota and local time zone.

The account card requests retained usage for recognized model groups and valid cycle
windows. Fresh Google enrollment records private evidence from the user-info response.
It joins retained attempts for the same verified Google account across local re-adds.
Accounts without that evidence use their current incarnation and credential instead.
Imports do not supply identity evidence. See [physical-attempt accounting](../proxy-gateway/diagnostic-retention.md#physical-attempt-usage-accounting)
for coverage and ambiguity limits. The result is not an authoritative balance.

## Quota observation ordering

Quota storage retains separate summary buckets. Each quota update merges omitted
active buckets and expired depletion with the current stored snapshot inside the guarded transaction;
a matching newly observed bucket replaces the previous value. Missing summaries
and partial groups do not clear known weekly protection. Omitted expired positive buckets
are removed; expired depletion remains evidence that needs a bounded recheck, without
inventing a new cycle or quota. The model response remains
separate from raw group fractions. Manual, monitor, enrollment and warmup results
use the same merge. Existing records need no format migration.

Weekly and seven-day display selection share the gateway's window recognition.
Display rounding is independent of exhaustion: weekly remaining fraction <= 0.001
is depleted, while a positive fraction such as 0.004 stays positive for scheduling.
Current group/model matching uses explicitly recognized legacy labels; authoritative
membership IDs are not available in the current upstream summary contract.

Successfully decoded summary buckets carry `observed_at`, the local Unix millisecond
instant of that response. Omitted buckets retain their original observation time;
reading, importing or merging a snapshot does not manufacture a fresh time. A bucket
with an older or missing observation time cannot weaken a recorded, unexpired newer
restriction or certify its recovery. A reported depletion can still restrict a
previously positive window after clock rollback. Equal times allow idempotent writeback; D01's
ownership and completion-order fences remain responsible for concurrent operations.
This metadata is not a provider timestamp or a freshness TTL. Clock rollback can
conservatively retain prior evidence until a later observation or its reset.
A missing or malformed reset cannot certify recovery of a recorded window.
A positive value with an already expired reset also cannot replace depletion.

Window identity preserves the exact bucket ID and normalizes whitespace/case in
the window label, treating `week`, `weekly` and `7d` as the same weekly window.
Empty bucket/window identities cannot certify recovery. Group display names still
scope this legacy matching; group renames and authoritative membership remain D08
joint work. Raw provider window strings are retained for diagnosis.

The optional timestamp is an additive field in the existing quota JSON, with no SQL
migration or historical backfill. Old snapshots remain readable with unknown times;
malformed timestamp values are rejected by the existing account codec. Older readers
ignore the optional field and can lose its protection when rewriting data. Packaged
upgrade/downgrade and real-provider acceptance remain separate evidence.

Manual refresh, monitor polling, enrollment finalization, post-warmup refresh and
the gateway's error-driven quota probe share an account-scoped, in-process ordering
fence in the profile owner. Each manual invocation starts an observation before its
account read; the monitor starts one when processing each account, enrollment after
insertion, and warmup after generation when its quota follow-up starts. The gateway
starts one for its realtime quota probe. Calls can run concurrently.

A newer observation supersedes older observations only when its quota response or
terminal failure is accepted under the current stored identity/token context.
Starting a newer query alone invalidates nothing. A successful quota response is
accepted before optional AI credits finish; a terminal failure fences older success
without inventing a replacement quota. Existing unauthorized recovery remains part
of the same observation and does not add retries.

The same fence is checked in guarded quota/status/token writes and subsequent
recovery and presentation effects. The monitor checks again before aggregate quota
notification and after auto-switch waits before choosing warmup inputs. Its quota
fallback and warmup's cached credits come from current storage at probe admission,
rather than an earlier scheduling snapshot. Accepted warmup history is preserved
independently as evidence of a potentially billable generation request.

Superseded manual work fails with the context-changed error; monitor and warmup
omit its remaining effects. Enrollment keeps confirmed account persistence and
reports the stale finalization through its login diagnostic. Already committed
writes remain committed; separate follow-up mutations are not one transaction.

Observations close on all exits. A newer completed observation's watermark remains
while older work can resume, and is released when all concurrent observations for
that account drain. No schema, persistent clock, provider cancellation or new retry
is introduced. Account incarnation and token guards remain independent. This fence
does not order ordinary generation completions against quota observations or make
external eligibility changes and cross-owner final-check/effect gaps atomic.

## OAuth refresh ownership

Manual quota refresh and the account monitor own a writeback context containing
the original account identity, creation time, grant, OAuth client, proxy and access
token. They check it after provider waits, before further dependent work, and in
the SQLite transaction that writes token, quota, status or last-use state. A token
write advances only that operation's expected context. A stale operation fails
with the internal context-changed error; it does not retry OAuth, report login
expiry, reuse cached quota as success or apply its failure status to a replacement.

The monitor omits accounts observed as stale from that poll's presentation effects
and continues processing other accounts. It retains the existing polling cadence,
401 recovery and quota/credit fallback for a current account. Monitor-only quota
polling still does not update last-use time.

Validation-health recovery passes the same guard through the health owner into
the write transaction and checks again before cache reload. Rollback also uses
the guard, so it cannot restore old health onto a replacement. If recovery and
rollback both fail, an aggregate error retains both failures and the original cause.
These are separate guarded writes, not one transaction for the whole provider
operation; earlier committed effects are not reported as rolled back.

Refresh operations are serialized per account. The persisted account, rather than
the caller's health hint, determines eligibility. A request whose refresh grant
already differs from storage, or whose account was deleted, fails before calling
the provider. The existing provider retry and two-operation `invalid_grant`
confirmation rules remain unchanged; a successful current-context refresh clears
OAuth failure state while preserving validation state.

Bounded gateway recovery supplies an optional in-process signal and owner fence.
They are checked before grant dispatch, after provider waits and inside queued health
mutations. Abandoned completions cannot clear health or add an invalid-grant strike;
distinct provider and ownership failures are retained together. A confirmed quarantine
keeps its revocation cause even when its own lease eviction cancels the request.
Credential persistence/publication and image queue lifetime belong to the
[lease owner](../proxy-gateway/account-leases.md#independent-quota-windows).

The refresh owner captures stored incarnation, account/provider identity, creation time, refresh grant,
OAuth client and stored proxy context. A queued health mutation verifies that
context against its final store read before writing. An old success cannot clear a
replacement account's OAuth state; an old invalid-grant result cannot add a strike
or block the replacement. A context mismatch raises an internal context-changed
error and retains an available original cause. It does not add a provider retry.

Live lease synchronization and OAuth eviction also carry an expected email, grant,
client and effective proxy. The lease checks those values synchronously at the
mutation point, including after the helper's dynamic import. These values stay in
process and are not logged, persisted as a new format or exposed over IPC. Ordinary
account deletion retains its unconditional cache-eviction operation.

Callers that do not supply a write guard retain their existing repository contract.
The guard is synchronous with the SQLite mutation; it cannot cancel a provider
request already dispatched. Stored contexts also compare the insertion incarnation,
so an identical-value deletion/recreation invalidates previously captured work.
Concurrent quota results in an otherwise unchanged incarnation retain their
existing completion ordering.
Effects delayed beyond the final context check remain separate lifecycle
obligations. Import commit guards are described below. The gateway owns
[cache publication and deletion cleanup](../proxy-gateway/account-leases.md).

## Import commit ownership

File import, local discovery and IDE sync capture their account-planning snapshot.
Their repository transaction compares each overwritten row with that snapshot
before writing any account or changing active markers. Comparison covers all stored
fields, including Token metadata, health, quota, proxy, device state and last use;
omitted optional JSON fields compare by persisted value. New ID, case-insensitive
email or refresh-grant claims made after planning reject the stale import. An IDE
import that activates an account also checks the previously active account set.
Unrelated additions do not invalidate an ordinary inactive import.

Local discovery checks the entire batch before any write and retains its atomic
failure result. File import retains per-account completion and bounded error codes;
earlier committed rows are not rolled back if a later row fails. Conflict adds no
automatic replay. Replacing a refresh grant guards subsequent failure-state cleanup
by its committed token and health snapshot, so a queued old follow-up cannot clear
new OAuth failure evidence or reload a replacement as its own success. A failed
follow-up may occur after the import row already committed; inspect the account
list before explicitly importing again.

Import plans retain the stored incarnation and reject an identical-value replacement.
Google enrollment also rechecks email admission at its insertion transaction;
effects already dispatched remain separate lifecycle obligations.

## Google enrollment email admission

Registration keeps its early duplicate check and repeats email admission inside
the insert-only repository transaction. The transaction acquires the SQLite write
reservation before reading email metadata, then either inserts and returns its
stored incarnation or rejects without inserting. Concurrent attempts for the same
email keep the first committed row; the loser does not replace its credentials,
clear its failure state or query its quota.

Email matching retains JavaScript lowercase equality, including non-ASCII case
folding. It does not trim addresses or merge Gmail dots and plus aliases. The
authoritative insertion check reads stored email metadata independently of token
decoding, so unreadable existing credentials do not make the identity available.
An import committed while login preparation waits is also observed at admission;
an older guarded import plan cannot claim an account newly committed by enrollment.

A conflict detected before preparation retains `duplicate-check`. A conflict
detected at insertion reports `account-persist`; both use `duplicate-account` and
`accountCommit: not-attempted`, meaning this attempt inserted no account. Desktop
and standalone login retain their expected-duplicate reporting policy. Previously
dispatched OAuth exchange or identity preparation is not undone or replayed.
Unrelated storage failures retain the existing storage-failure diagnostic and
commit uncertainty; message text is not used to infer a duplicate.

No unique index, schema migration, duplicate cleanup or process-local reservation
map is added. Historical duplicate rows and explicit unguarded upserts remain
outside this insert-only contract. Existing SQLite busy timeouts remain unchanged.
After all matching rows are explicitly removed, a fresh registration may proceed.

## Google enrollment follow-up

Enrollment inserts a new row and reads its stored snapshot in the same transaction.
It does not upsert an existing ID. The snapshot includes the insertion incarnation
and complete token context; a later read cannot adopt a replacement as this login's
own insertion. Existing accounts still use the separate guarded import/upsert path.

Failure-state cleanup receives that snapshot's token and health guards, including
inside its queue, so it cannot clear later OAuth failure evidence.
Initial quota and optional AI-credit queries recheck ownership after waiting, and
the quota write checks it inside the SQLite transaction. Deletion, identical-value
recreation or changed credentials stops remaining follow-up without mutating the
replacement. It does not replay authorization or the provider request.

The login diagnostic identifies `account-finalize` with `accountCommit: confirmed`
when ownership is lost after insertion. This failure cannot undo the inserted row;
refresh the account list before explicitly starting another login. Ordinary optional
quota/credit query failures retain best-effort login behavior without an added retry.
Returned quota is published only after its successful guarded write. The internal
incarnation remains absent from renderer views and account exports.

Current-context quota follows the [quota observation order](#quota-observation-ordering).
Presentation and external effects after the final check remain separate concerns.

One-time legacy OAuth-client backfill snapshots its input accounts and guards each
whole-token write against the captured identity and complete stored token. New
project/session/expiry metadata cannot be overwritten by an old backfill snapshot.
Undefined optional fields compare as omitted JSON fields. A rejected write retains
its cause, lets other accounts proceed and leaves the migration-complete marker
unset. Existing enterprise-project exclusions remain unchanged.

## Stored account incarnation

The database adds a `lifecycle_generation` column and an insert trigger. A transaction
backfills existing rows and installs the trigger; failure rolls that migration back.
Ordinary updates preserve the incarnation. Inserts naming only older known columns
also receive a fresh value. Account exports and renderer views omit it; importing
an old snapshot cannot copy its incarnation into a newly inserted row. Invalid
stored incarnations reject reads. The migration fast path does not rewrite them.

Configuration remains a separate file. Its cleanup follows committed deletion
through the configuration queue and uses a strict fresh read. Failure cannot roll
back deletion or justify replacing an unreadable configuration with defaults.
Admitted deletion drains before shutdown closes the configuration queue. See the
[upgrade and recovery guide](../../upgrade-guides/next/account-incarnation.md).

## Device binding ownership

Manual capture, generation and supplied-profile binding capture the stored account
incarnation, identity, complete token/proxy context, bound profile and history after
their account read. Automatic first binding captures the same fields before
generation. The binding store checks that snapshot and writes profile/history in
one SQLite transaction, including on duplicate-profile paths. A changed account,
token, profile or history rejects the old operation rather than adopting the newer
state, writing to a replacement or automatically retrying.

A matching already-bound profile keeps its no-op behavior. Matching history without
the requested binding materializes the profile without creating a duplicate revision;
reusing a latest revision also marks it current. A switch advances its expected
profile context only after its guarded binding succeeds. Rejected initial binding
stops before client credential preparation and candidate-baseline publication.

Manual binding publishes the global-original fallback only after the database
binding commits. If later baseline publication fails, the committed binding remains
visible: the operation reports failure with its internal cause and does not claim
rollback. Refresh the profile snapshot before an explicit retry. Public profile
errors keep their existing stable categories; original causes/stacks remain in the
trusted owner rather than the renderer result.

The identity-profile owner exclusively publishes the
[global original baseline](../identity-profile/overview.md#global-original-baseline).
Database binding and baseline publication are separate effects. Explicit revision
restore/delete retain their existing contracts; this does not add a persisted
binding generation or make external effects after the final check atomic.

## Automatic switching

The account monitor polls quota every five minutes by default. With automatic switching enabled,
the module can switch official Antigravity clients when the active account is rate-limited or when
all key model quotas or applicable shared quota buckets fall below 5%. The client toolbar controls
this behavior. It does not choose the account used by proxy API requests; that policy belongs to
the [proxy gateway](../proxy-gateway/compatibility.md).

Client switching crosses into `antigravity-runtime`, which owns process lifecycle and writes to
client credential stores. Follow the [account switching acceptance tutorial](../antigravity-runtime/account-switch-acceptance.md)
for real CLI and Electron evidence. Failure state and recovery expectations are defined in
[failure ownership](../../error-handling.md).

Each cloud switch captures stored account identity, creation time, the complete
token, proxy context and bound device profile. Its own initial profile binding
and committed token updates advance that context; it does not adopt another
operation's token or profile. Checks follow asynchronous launch preparation,
refresh, project discovery and credential preparation. Token writes compare
the same context inside their SQLite transaction. A stale refresh cannot change
a replacement's status. Enterprise project discovery remains best effort for
an unchanged account; a discovered-project persistence failure stops the switch.

The runtime accepts an optional owner check without importing cloud-account
implementation. Cloud switches use it around credential writes, after awaited
preflight, before restart and terms application, after terms application, and
before success publication. This also prevents macOS hot-switch best-effort
reassertion recovery from hiding a changed account. Local switches retain their
existing behavior without this callback.

After client write and process confirmation, one SQLite transaction checks the
context and commits global active selection, last-use time, active status and
the selected target's active-account setting. A failed check or setting write
rolls back all these Manager markers. Success events and presentation follow
commit and another context check. Other targets' settings and tokens remain
unchanged by finalization.

These checks stop later effects; they cannot cancel a credential write or process
operation already dispatched. Profile binding, refreshed credentials, official
client storage and the final Manager transaction are separate effects. A late
failure preserves diagnostics, publishes no successful switch and adds no
automatic retry. It does not claim official credentials were restored; a started
client may remain running. Classic terms retain their existing guarded rollback
only before startup is attempted and verify the restored consent fields by readback.
Startup and required hot-switch errors keep their original cause in trusted logs;
compound switch/recovery failures retain both causes within the existing bounded,
value-free diagnostic. The diagnostic's rollback field refers to official credentials;
consent-only recovery does not change it to credential recovery success. Existing macOS
best-effort credential reassertion remains best effort. Initial binding follows the guarded transaction
above. Final-check-to-effect gaps across external stores remain outside that
transaction, even when the bound account is current at the last check.

## Weekly warmup

Weekly warmup is off by default and is configured under Settings > Models. Enabling it keeps the
existing five-minute monitor running when automatic switching is off. Only successful fresh quota
or token refreshes, including manual refreshes, provide candidates. While warmup is enabled, the
visible account list rereads local snapshots every minute; this renderer refresh does not call the
provider.

Eligibility requires a Google account without a non-active status or forbidden quota flag, at
least `0.999` remaining fraction, and a valid reset timestamp that passed less than six days ago.
The selected Gemini or Claude group must be enabled. Weekly requests use `gemini-3-flash` or
`claude-sonnet-4-6` as the representative model. A group dedicated to one model family is warmed
only when the representative model belongs to that family, so Gemini 4 Argon is not warmed.
Missing weekly groups and unavailable project context are not replaced with guessed values.

Each candidate includes advertised physical models from the selected account and
quota group. Authoritative `model_ids` membership takes priority over legacy group
labels. An empty or unknown account catalog is skipped with a diagnostic before
project discovery and generation. The gateway executor resolves the representative
through the generation route policy and binds only to an advertised model in that
group. A configured replacement outside the group fails before sending. A skipped
candidate does not write warmup success history.

Warmup consumes real model quota and may use AI credits. An accepted HTTP response is recorded as
success; it does not prove that the provider restarted a weekly timer or completed generation. The
application rereads quota after successful warmups, and it makes no live-provider timer or cost
guarantee.

`WeeklyWarmupService` owns a serial main-process queue shared by scheduled and manual refreshes.
There is a two-second delay between candidates. Configuration changes and monitor shutdown cancel
the active generation request and prevent queued candidates from starting. An already accepted
provider request cannot be undone.

Warmup and its quota-follow-up runner snapshot account inputs when admitted. They
check stored identity, grant/client/proxy and access-token context before discovery
and generation; a queued input cannot adopt later caller mutations. Project writes
also compare the complete token inside the SQLite write transaction, preventing an
old discovery from replacing a newer project/session value. Cancellation is checked
again after account reads and before dispatch. Changed-account failures retain
their diagnostic cause and do not automatically retry.

After accepted generation, the existing cycle history is still saved even if the
account context changed meanwhile. This records a potentially billable effect and
prevents another warmup for that account/bucket/reset cycle, including a replacement
with the same ID. It does not establish success for the replacement. Such completion
is logged as accepted with failed account follow-up and is omitted from follow-up
quota IDs. Existing cancellation semantics still suppress history when cancellation
is observed after the request returns. A failed history save still pauses warmup.

The quota runner checks context before its probe and guards its SQLite quota write.
It no longer mutates caller-owned account objects; current views reread stored quota
through their existing refresh policy. Already dispatched requests are not cancelled
solely by deletion, and final-check/provider-dispatch gaps and identical-value
delete/recreate remain outside this context guard's guarantee.

Failed requests do not create success records and can be retried after a later fresh refresh.
Invalid or unreadable history, or a history write failure after provider acceptance, pauses warmup
until application restart. Repair the underlying storage problem before restarting; otherwise the
safety check pauses it again. Invalid configuration remains an error in Settings instead of being
silently replaced with enabled defaults. A process crash after provider acceptance but before
history persistence can cause another request after restart; execution is not exactly-once.

The module stores validated warmup configuration and versioned history in existing settings rows;
it does not add a database schema. History keys contain account ID, bucket ID, weekly window, and a
normalized reset timestamp. Equivalent timestamp offsets and legacy string timestamps resolve to
the same key. Successful entries are retained for 30 days, and older reset cycles remain excluded
after retention cleanup.

The proxy-gateway adapter uses the existing Claude mapper or native Gemini request envelope and
`GeminiClient` transport. It first requests `streamGenerateContent?alt=sse`, then falls back to
`generateContent` on transport failure; it does not repeat an HTTP rejection as a non-streaming
request. Content requests preserve the project in the body but omit `x-goog-user-project`, including
after extra headers are merged. Known metadata/count internal methods may remove the
quota-project header once after a structured Google consumer denial matching the actual
unambiguous header. Ordinary 403 and arbitrary diagnostic verbs do not permit downgrade;
body.project and other headers remain. A 60-second deadline and cancellation signal bound transport work. No
internal HTTP endpoint or authentication bypass is exposed.

## Persistence and security

Cloud account credentials are stored in the local application profile database. The
[account storage contract](security.md#account-storage-and-conversion) owns the representation, conversion backup and recovery
policy. Do not put account tokens in logs, reports, IPC diagnostics, screenshots, or test fixtures.

## Related references

- [Cloud-account security](security.md): storage conversion, OAuth sessions, strict public views,
  imports/exports and background-operation boundaries.
- [Architecture and module boundaries](../../architecture.md#feature-ownership)
- [Identity profile and desktop storage initialization](../identity-profile/overview.md)
- [Testing strategy](../../testing.md)
- [Failure ownership and recovery](../../error-handling.md)

## Focused persistence checks

For cloud-account plaintext storage, run the focused batch-writer tests with `pnpm test --run
src/tests/unit/cloud-account-batch-writer.test.ts`. Conversion and plaintext persistence tests use
real disposable SQLite databases and need the installed Electron ABI on Windows:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& .\node_modules\electron\dist\electron.exe .\node_modules\vitest\vitest.mjs run src/tests/unit/convert-encrypted-account-fields.test.ts src/tests/unit/cloud-account-plaintext-persistence.test.ts
```

`cloud-account-plaintext-persistence.test.ts` exercises real SQLite account deletion, current-account
reference cleanup at startup, repeat deletion, unrelated-setting preservation and transaction rollback
using disposable databases. Run it with `cloud-account-settings-store.test.ts`,
`cloud-account-adapter.test.ts`, `core-rpc.test.ts` and `convert-encrypted-account-fields.test.ts`
for the adjacent desktop and standalone contracts. When the workspace SQLite binary was rebuilt
for Electron, run the same Vitest entry with the matching Electron executable and
`ELECTRON_RUN_AS_NODE=1`; do not rebuild it for Node over the desktop binary just to run these tests.
This establishes native persistence behavior, not installed-client sign-out or live-provider requests.

The conversion suite verifies both encrypted and decrypted database copies before live conversion,
committed WAL data, complete account/settings/workspace preservation, no-key plaintext recovery,
retained history, failed preparation/publication/readback and final-transaction rollback. Controlled
updates across key-provider and backup boundaries verify that migration does not overwrite newer
account fields. These tests mock only historical key access and decryption, not SQLite or backup I/O.

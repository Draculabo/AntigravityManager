# Agent Note: Independent quota-window evidence

Status: implemented

## Problem

Gateway quota projection collapsed all Claude/GPT groups to one rounded minimum.
Equal zero windows could choose the earlier reset; small positive balances could
become zero. A refresh omitting a weekly window could overwrite stored evidence
and clear protection based only on a model or five-hour response.

## Decision

The cloud-account owner keeps the existing quota payload format. A window helper
derives model constraints from raw buckets without modifying their fractions or
reset strings. Weekly/7d balances at or below 0.001 are exhausted; other windows
require actual zero. Exhausted deadlines compare parsed instants and combine by
the latest depleted deadline, excluding non-depleted windows.

Quota writes merge omitted active windows and expired depletion inside the repository's
existing synchronous guarded transaction. Missing optional summaries do not mean
recovery. Manual refresh, monitor, enrollment, warmup and gateway refresh use the
same merge for their owned results. A matching fresh bucket replaces its prior
observation with a current reset. Expired positive omitted buckets are dropped;
expired depletion remains a recheck requirement without inventing a new cycle.
Malformed reset evidence is not turned into a precise future deadline.

Realtime reconciliation clears only explicitly refreshed model/window scopes;
account-wide recovery also requires coverage of previously known models. Lease
route waiting includes current group-window constraints, and stored eligibility
detects newly observed depleted windows before a stale completion can recover them.
Existing D01 ownership/ordering guards, retry budgets and hard-quota policies remain.

The current summary contract has display labels and bucket IDs but no authoritative
model-membership IDs. Window identity keeps the exact bucket ID while normalizing
case/whitespace and weekly/7d aliases in its window label. Empty identities cannot
certify recovery. Group display names still scope the legacy match; this does not
invent stable group IDs or allow a rename to transfer another group's protection.
This implementation therefore
keeps an explicit legacy matcher with specific Claude-family labels taking
precedence over broad bucket hints. It does not claim final D02/D08 group identity
or official-cycle accounting completion.

Successful summary decoding records one local `observed_at` Unix millisecond time
for that response's buckets. It is an optional field in the existing JSON payload;
historical snapshots stay unknown. A merge, read, import or partial response cannot
restamp retained evidence. Older or timestamp-free matching buckets cannot weaken
an unexpired recorded restriction or certify recovery. A newly reported depletion
can still restrict a previously positive window after clock rollback; otherwise a
local clock would incorrectly act as permission to ignore a provider restriction.
Equal times are idempotent;
these times do not replace D01's identity and completion-order fences, or define a TTL.
An absent or malformed reset is not complete recovery evidence; the raw unknown
field remains diagnostic rather than being converted into a valid reset.

## Alternatives considered

- Minimum integer percentages lose positive precision and independent resets.
- Earliest reset can release a request while another exhausted window remains.
- Treating a missing summary as positive evidence clears protection after partial failure.
- Adding a second quota database or guessing group memberships would introduce
  unsupported storage and entitlement contracts.
- Discarding every prior bucket on a complete-looking response is unsafe without
  an authoritative completeness marker. Positive omitted evidence is retained to
  expiry; depletion remains a recheck requirement after expiry.
- Stamping snapshots on read/import/merge would turn stale data into recovery evidence.
- Making timestamps required would reject historical snapshots without any way to
  reconstruct their actual observation time. The field is optional and not backfilled.
- Discarding expired depletion during a partial manual/monitor response lets later
  selection bypass recovery. Retain it as probe evidence, with the original deadline.
- Blind generation after expiry can consume a request on a still-depleted account;
  account-first scheduling can instead remain stuck on zero. A bounded quota lookup
  reconciles these paths without treating deadline expiry as positive evidence.

Ordinary selection rechecks at most one expired account when no immediately usable
account exists. It shares the existing wait deadline, caps lookup time at two seconds
and spaces attempts by 30 seconds for the same cache context. The cap matches the
existing short-selection wait bound; the interval limits endpoint pressure after
partial failure. No extra durable configuration or background timer is introduced.
Concurrent callers do not queue. Per-entry state is weakly owned; a timed-out adapter
stays single-flight until it settles. Abort, cache identity, current lock/cooldown and
absolute deadline checks prevent late publication. Discovery/model/summary and
fallback waits share cancellation. Already committed valid storage is not rolled back.

Recovery now hydrates credentials before quota lookup within that same two-second
deadline. It reuses the existing five-minute refresh threshold and finite provider
retry/client fallback; it does not replay generation or tools. Request-owned refresh
publishes only after guarded serialized persistence succeeds. A missing stored account
is a stale owner, never a successful no-op write. Cancellation or uncertain write
completion evicts only the unchanged cache context, allowing a subsequent load to use
authoritative durable credentials. An already dispatched grant can have unknown remote
effects, including rotation; cancellation provides no remote rollback or exactly-once
guarantee. No new automatic grant replay is added to resolve that uncertainty.

Image acquisition shares one probe allowance and wait budget across queue wakeups and
busy-account reselection. Its whole lifetime, including renewal and owned cold project
discovery, is bounded by the earlier caller/configuration deadline. It takes no permit
during preparation and releases a permit that races cancellation. Shutdown owns all
image controllers. Independent existing project probes retain their original owner;
a canceled joining caller cannot revoke valid work belonging to another request.
Cancellation does not install a project failure TTL or publish its late token snapshot.

## Consequences

No schema migration, credential location, new public protocol field, dependency,
automatic tool retry or real-provider acceptance is added. Existing records remain
readable; retained windows use the existing quota_groups array. Rollback to an older
binary remains readable but loses the conservative merge and projection behavior.
Historical data cannot acquire missing observation times retrospectively.
The optional timestamp uses the existing payload and needs no SQL migration or user
action. The current codec rejects malformed provided timestamps. Older readers strip
unknown optional fields and lose this protection on rewrite; packaged downgrade is
not established by codec/native source tests. Clock rollback may retain protection
conservatively until an adequate later observation or the known reset.

Client display keeps its existing raw windows; weekly and 7d recognition share the
same helper. Display rounding does not establish exhaustion. Account cards now
explain observation times, depleted/unknown/expired windows and rounded positive
balances. A family visible in either display preference retains restriction reasons
for hidden windows; fully hidden families remain hidden. Restriction summaries are
per group and do not claim to include unrelated runtime cooldowns. One cancellable
timer per section updates time-dependent reasons without fetching quota or declaring
recovery. UI time is explicitly supplied to pure reason helpers. Authoritative group
IDs/model mapping, official-cycle accounting and full D02 acceptance remain open,
with D08 joint obligations.
Subscription identity and backend refresh retention are owned by the separate
[subscription decision](2026-10-17-subscription-identity-refresh.md).

## Verification

Five initial failing controls demonstrate premature reset choice, positive-fraction
rounding, unrelated group coupling and partial-refresh recovery. Focused policy and
temporary native SQLite tests cover retained/explicitly replaced windows, rejected
owners and unchanged source payloads. Public Google API tests substitute transport
and check missing/out-of-range summary fractions remain unknown rather than zero.
Executed commands, combined regressions and platform limits are recorded in the
D02 implementation report (local artifact `D02-independent-windows-implementation.md` in the 2026-10-11 review collection).
Observation controls, API timestamping, native SQLite round trips and current evidence
are in the window observation report (local artifact `D02-window-observation-implementation.md` in the 2026-10-11 review collection).
Bounded lookup, cancellation and partial-writer expiry evidence are in the
expiry recovery report (local artifact `D02-expiry-recovery-implementation.md` in the 2026-10-11 review collection).
Credential preparation, image scheduling, missing-owner regression and current evidence
are in the token/image recovery report (local artifact `D02-token-image-recovery-implementation.md` in the 2026-10-11 review collection).
Observation/restriction presentation, reset transitions and timer cleanup evidence
are in the evidence UI report (local artifact `D02-freshness-ui-implementation.md` in the 2026-10-11 review collection).

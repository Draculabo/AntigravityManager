# Agent Note: Pool-derived ordinary attempt ceilings

Status: implemented

## Problem

Ordinary protocol operations and token counting had a fixed three-slot outer
loop. A four-account pool with hinted failures on A/B/C never reached a healthy
D, although these failures do not consume the separate generic two-account 429
budget. Independent protocol constants also made consistent future grace
accounting harder to verify.

## Decision

AccountLeaseService supplies a potential pool snapshot, after loading the local
account cache if empty. It filters validation quarantine and existing model
capability preference. Refresh-disabled accounts are already omitted by the
token cache. Temporary cooldown and quota eligibility are deliberately excluded
from this count, but continue to govern every actual selection. Reading the
snapshot does not hydrate a credential, discover a project, reserve capacity or
change a conversation binding.

ProxyRetryService calculates three ordinary slots for zero/one potential account,
or twice the count bounded to 4–12 for larger pools. All ordinary generation and
token-count loops consume the same operation-local ceiling. Image-model and
explicit image operations retain their existing three-slot policy. Existing
request cancellation guards the snapshot operation before an upstream send.

## Alternatives considered

- Count only currently unlocked accounts: rejected because temporary penalties
  would redefine the normal ceiling and obscure later-round eligibility.
- Count every stored account regardless of capability or OAuth health: rejected
  because unavailable identities would inflate the budget for unrelated models.
- Clear exclusions or quota locks to fill all slots: rejected. This slice only
  changes the ceiling; round re-entry belongs to the separate grace/round policy.

## Consequences

Hinted or non-rate-limit failures can reach additional eligible accounts. The
generic unhinted two-account stop remains authoritative. A pool may still end
early when no untried account is eligible; expanding the ceiling does not promise
two completed rounds or three single-account sends. Those R3/R4 execution rules,
and grace not consuming normal slots, remain pending. No durable data format,
OAuth location, model routing contract or tool execution behavior changes.

## Verification

Before implementation, four unary protocol cases, two token-count cases and the
twelve-account cap case failed against the fixed three-slot loop. Controlled
coverage verifies fourth-candidate success for unary and streaming operations,
pool ceilings at 0/1/2/3/6/20, a twelve-send cap, pre-aborted requests, no hydration
during snapshots and unchanged image/generic-limit behavior. Logs and current
source hashes belong to the D01 controlled slice report in the replication
artifacts. Real model acceptance remains deferred.

See [current behavior](../../../../docs/modules/proxy-gateway/compatibility.md).

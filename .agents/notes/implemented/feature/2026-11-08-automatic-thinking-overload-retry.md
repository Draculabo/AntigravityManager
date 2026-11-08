# Agent Note: Automatic thinking overload recovery

Status: implemented

## Problem

An upstream model-overload response previously entered account or protocol
fallback without an opportunity to reduce automatically selected thinking work
on the same account.
The user approved a restricted policy on 2026-11-08 that preserves explicit choices.

## Decision

The protocol service captures original thinking intent once, before variants and
defaults. A request-local recovery owner is passed to the common upstream client.
Admission requires explicit overload evidence, an adaptive final budget, sufficient
output headroom, a current account lease and the existing request deadline.
The owner permits one additional same-account send and is shared across ordinary
account/project/protocol fallbacks. Named fixed recipes, explicit controls,
configured physical targets and image generation remain excluded.

The upstream client captures the actual failed wire body and transport. It sends
one immutable budget-adjusted copy with endpoint/project fallover disabled for
that additional send. Content, model, output allowance and session are preserved.
The subsequent failure returns to existing account/error ownership. Returned
streams retain their established lifecycle. No persisted recovery state is added.

## Alternatives considered

- Broad 503 classification and model-name replacement would
  override user-selected High tiers and treat unrelated service failures as
  evidence for changing generation policy.
- Wrapping each protocol's account loop would repeat preparation and risk divergent
  replay rules. The common client owns the final wire representation and transport.
- A global allowance would couple unrelated requests; a per-account allowance
  could degrade multiple times as one request rotates through the pool.

## Consequences

Automatic requests may recover with less thinking work. Recovery probability and
provider prefix-cache benefits depend on the live service and are unmeasured.
One additional send consumes request time and possible provider quota. The
original deadline and cancellation still own the complete request lifecycle.
The structured decision log excludes payloads and credentials. Removing the
task-owned source changes restores the earlier policy without a data migration.

## Verification

See the implementation and evidence (local artifact `d06-overload-status.md` in the 2026-11-07 review collection)
for negative controls, focused checks, runtime boundaries and environment limits.
Controlled HTTP fixtures use production ingress, protocol services and upstream
HTTP transport with synthetic account leases and a disposable local upstream.
Installed-client and real-provider overload acceptance remain pending.

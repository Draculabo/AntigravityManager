# Agent Note: Account-specific model capability avoidance

Status: implemented

## Problem

The base proxy turned every non-image 404 into a global, permanent rejected-model
entry. One account could therefore change routing for every other account. Image
404/403 status alone produced capability failures, including ambiguous project or
credential responses. Those records were not consistently enforced by selection,
and a quota refresh cleared image records without proof of generation recovery.

## Decision

Use one shared availability owner for explicit capability evidence and selection.
Records are account/physical-model scoped and expire after 900 seconds. Recognized
structured model reasons or explicit text naming the physical target establish
failure. Project, authentication, validation, security-policy and tool/Schema failures
retain their existing owners. Status alone cannot create a capability record.

Remove the permanent global set and its mutation API. Existing safe sibling routing
reads only the selected account's advertised candidates and filters active denials.
Unknown catalogs cannot hide a known denial. A generic quota refresh is not positive
generation evidence; actual model success clears that model's capability record.
Image-family temporary-limit cleanup preserves sibling capability records.

Advertised catalog and output metadata reads move into an owned catalog module,
separate from request eligibility. Existing model-policy accessors retain their
same-process contracts. No durable format, credential location or new protocol
field is introduced. Current behavior belongs in
[account leases](../../../../docs/modules/proxy-gateway/account-leases.md#account-specific-model-failures).

## Alternatives considered

- A process-wide rejection flag incorrectly treats one account's entitlement as
  evidence for every account and has no bounded recovery.
- Treating every 404/403 as capability failure hides project and credential causes.
- Clearing on catalog refresh repeats rejected generation when a catalog advertises
  an ID that the generation service cannot serve.
- Arbitrary suffix replacement can merge distinct model identities. Exact physical
  keys are used until D08 defines known base-model and upstream-entry identities.

## Consequences

A recovered model can remain avoided until the 900-second deadline unless an actual
success supplies stronger evidence. This deliberate delay bounds repeated rejected
requests. Incomplete model/error identity leaves the original error visible and
does not create a speculative denial. Retry budgets, hard-quota protection, session
success commit and image permits remain separate owners.

This is the D01-owned R9 slice. D08 base-model entitlement sharing, entry scoping and
positive-catalog semantics remain pending, as do complete R12 account deletion and
in-flight lifecycle guarantees. Generic cache reload preserves current account-ID
capability records; it is not treated as an entitlement change.

## Verification

The initial eleven controlled real-lease scenarios failed five cases before changes.
Coverage includes two-account isolation, unknown catalog rejection, 900-second expiry,
reload/restart, exact success cleanup, ambiguous 404, structured/mismatched model
evidence, credential failure and sibling image success. Four production protocol
services rotate from a rejected A to successful B using synthetic upstream adapters.
The catalog extraction retains output/metadata and routing regression checks.
Executed commands and limits are recorded in
D01 R9 evidence (local artifact `d01-r9-implementation.json` in the 2026-10-11 review collection).
Live provider and packaged-client acceptance remain deferred by the rollout contract.

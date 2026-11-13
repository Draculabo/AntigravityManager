# Agent Note: Cowork compaction coordination

Status: implemented
Date: 2026-10-19

## Problem

Keep ordinary conversation history intact. Cowork compaction is an opt-in coordination flow owned by the client: the gateway may request local compaction only after an explicit source and semantic control check, and it must wait for a provider summary plus adoption of new history before marking the operation complete.

## Decision

D13 adds the bounded coordination state machine, configuration defaults, fixed-overhead
threshold calculation and settings UI. The Messages route owns the local control response.
The client initiates the provider summary and adopts the resulting history.

A recognized summary instruction in a system text block can join an active operation only
after the same trusted session and exact original history prefix have matched. The first five
messages can carry the adopted summary. The provider fingerprint remains required. The
manual `/compact.` alias follows the existing manual admission rules. JSON and SSE
acknowledgements identify their local response source and have zero provider usage.

Native compaction can summarize only an older prefix and keep recent messages.
To associate that request, the gateway requires an active trusted manual or automatic operation,
the observed summary-block structure, and an exact prefix proof apart from cache
annotations and the delimiter next to the appended instruction. It stores bounded
message fingerprints rather than conversation text. Adoption requires both the actual
provider summary and the retained suffix proof. The native command retry can receive
a local acknowledgement while an ordinary follow-up continues to the provider.
Automatic operations retain the same bounded prefix fingerprints and resume the pending
generation after adoption. Their continuation protection uses the existing expiry policy.

## Alternatives considered

Keeping compaction as an implicit gateway rewrite was rejected because it could alter ordinary conversation history and make client-owned summaries unverifiable. A second independent summary job for duplicate requests was rejected because it creates competing continuation states.

## Consequences

- Automatic and manual coordination default to disabled.
- Active operations are keyed by tenant, client session and generation.
- A duplicate request reuses the existing operation; it never creates a second summary job.
- A failed or cancelled summary does not create continuation protection.
- A completion requires a different adopted history fingerprint.
- Capacity exhaustion rejects new coordination and never clears active entries.
- Successful adoption reserves one scoped protection for up to 300 seconds before
  activation. A continuation with the exact operation, generation and adopted-root
  fingerprint activates or renews a 30-second sliding window. Expiry never revives.
- Active work reserves future protection capacity, so completion cannot displace another
  session's live protection. Protection and active limits are independently bounded.
- A new operation and scoped invalidation revoke older protection and confirmation;
  late provider results cannot recreate the invalidated operation.
- Unknown sources cannot acquire work. The protocol owner must establish trusted Cowork
  identity independently; a text tag or function name never supplies that authority.
- Tenant/session keys use tuple encoding, avoiding separator ambiguity. Snapshot counts
  include protection entries for bounded-state diagnostics.

## Verification

See local artifact `D13-context-compaction-implementation.md` in the 2026-10-11 review collection.

The 2026-11-05 continuation follow-up uses deterministic clocks for 299/300-second
activation, 29/30-second renewal, capacity reservation, tenant/generation/adopted-root
isolation, scoped deletion and late summary refusal. It does not establish real provider
summary success, client adoption or a protocol request-path integration.

The 2026-11-10 HTTP integration checks use the production Messages controller,
generation client, and a synthetic loopback upstream. They cover local trigger,
system-block summary association, provider summary completion, exact adoption at
message four or five, JSON/SSE zero-usage acknowledgement, wrong summaries,
session/history isolation, provider failure cleanup, and expired protection.
Installed curl exercises the same sequence and observes the response source
header on both wire formats. A native Cowork capture established the partial-summary
request shape, the provider summary, and the retained message suffix. The captured
sequence verifies the matching functions locally. The new HTTP regression verifies the
gateway acknowledgement with a loopback provider. A live rerun with the fix remains pending.

# Agent Note: Cowork compaction coordination

Status: implemented
Date: 2026-10-19

## Problem

Keep ordinary conversation history intact. Cowork compaction is an opt-in coordination flow owned by the client: the gateway may request local compaction only after an explicit source and semantic control check, and it must wait for a provider summary plus adoption of new history before marking the operation complete.

## Decision

D13 adds the bounded coordination state machine, configuration defaults, fixed-overhead threshold calculation and settings UI. It deliberately does not emit control responses or summarize history in the gateway; those integrations remain with the protocol owners in a later slice.

## Alternatives considered

Keeping compaction as an implicit gateway rewrite was rejected because it could alter ordinary conversation history and make client-owned summaries unverifiable. A second independent summary job for duplicate requests was rejected because it creates competing continuation states.

## Consequences

- Automatic and manual coordination default to disabled.
- Active operations are keyed by tenant, client session and generation.
- A duplicate request reuses the existing operation; it never creates a second summary job.
- A failed or cancelled summary does not create continuation protection.
- A completion requires a different adopted history fingerprint.
- Capacity exhaustion rejects new coordination and never clears active entries.

## Verification

See local artifact `D13-context-compaction-implementation.md` in the 2026-10-11 review collection.

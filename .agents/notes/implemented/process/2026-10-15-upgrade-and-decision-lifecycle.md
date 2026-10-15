# Agent Note: Upgrade instructions and decision retention

Status: implemented

## Problem

Data and public-interface changes already require recovery evidence, but there was no dedicated trigger for user upgrade instructions. Decision records had lifecycle and cross-link guidance without a precise way to retire a completely replaced choice. An obsolete record could therefore appear to describe current behavior.

## Decision

Write user upgrade instructions in the introducing incompatible change. The [guide reference](../../../../docs/upgrade-guides/README.md) owns triggers, placement and required user actions, recovery, downgrade limits and verification. New guides use a `next` directory until their target release is known. Existing Agent-contract checks validate their mechanically decidable structure and current references.

Use explicit reciprocal replacement metadata for complete decision replacement. Archived notes remain implemented historical records with an archive date and replacement. Validate existing targets and acyclic relationships while preserving historical body references. Partial changes keep their still-valid owner active. Archive-body preservation and retirement relevance remain review judgments, not inferred code properties.

The layered-governance and AI-review decisions still govern current work, so they remain active. Their narrowly outdated descriptions of dependency enforcement and hook jobs were updated to current owning references. No existing decision is fully superseded by this change and none was moved or deleted. No application incompatibility was introduced, so no user migration guide is invented for the current release.

## Alternatives considered

**Rely on release notes alone.** A change summary does not establish affected users, preparation, recovery or downgrade constraints.

**Infer incompatibility from edited files.** A persisted-data file can change compatibly and an API break can occur in several layers. Human review owns the trigger; automation checks the resulting guide and its evidence references.

**Archive by age or repair historical body links.** Age does not establish irrelevance, and rewriting old references obscures the original decision. Active links and replacement metadata remain maintained; historical bodies stay frozen.

**Retire an entire decision after a partial change.** Remaining constraints and rejected alternatives still matter. Update the current owner and retain it while those obligations guide work.

## Consequences

The existing governance command, local hook and CI selection execute the additional document checks without another public runner or dependency. Code review separately verifies migration behavior and archived-body preservation. This change affects repository governance only; it does not migrate user data, change authentication or alter release execution. Removing the new document checks and references restores the previous governance policy.

## Verification

The governance fixtures cover complete and incomplete upgrade guides, version mismatches, reciprocal replacement metadata, invalid encoded links, archive status/date, preserved historical references, multi-generation replacement and cycles. The real governance CLI rejects an invalid guide. Windows Node 24 and Linux Node 25 run the document tests; these results do not claim a fresh Node 22 CI execution.

The actual shared governance selection passed its Agent contracts, quality contracts, runner tests, change-scope/import tests and runtime/type boundary checks on Windows. A real temporary-repository commit also verified that changes to the lifecycle validator select governance and are blocked when it fails. Focused ESLint and formatting checks passed. GitHub execution and the full application suite remain unverified for this document/script-only change.

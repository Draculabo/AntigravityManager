# Agent Note: Model routing and capability ownership

Status: implemented

## Problem

Route aliases, model variants and account capability failures were previously
resolved by separate paths. A route could be visible in a directory while the
selected account could not generate it, and one account's capability failure
could influence another account.

## Decision

Model route matching and account capability evidence have separate owners. Route
matching resolves the configured alias, wildcard and canonical family in a
deterministic order. Capability evidence is scoped to the selected account and
physical model family, expires after a bounded interval, and is cleared by
matching generation success or expiry. A catalog entry is descriptive data; it
does not by itself grant generation eligibility.

The implementation keeps explicit model aliases and physical tier identities
stable across OpenAI, Anthropic and Gemini request paths. Unsupported effort
values fail before account selection. Account-local capability denials survive
ordinary cache reload and do not become a process-wide rejection flag.

Resolved targets carry physical provenance through ordinary and grace retries, account filtering,
quota/cooldown recovery, targeted selection, refreshed candidates and final binding. Public presets
and physical recipes can share a name but differ in budget. A configured physical target therefore
cannot be reinterpreted as a public preset or rewritten by a legacy alias. Explicit fixed tiers
require the complete registered profile, including automatic-budget sentinels. Existing registered
provider retirement forwarding keeps its explicit replacement semantics. Count and generation
consume the same resolved target and admitted thinking level.

Explicit configured replacements precede runtime retirement forwarding, with
retirement still ahead of wildcard rules. This partially replaces the prior R2
ordering recorded in the original D08 plan. Discovery uses the same route policy
and publishes provider capabilities only when eligible account evidence agrees.
The retired Pro High and legacy agent IDs are rejected at route resolution. Stale
account catalogs cannot reintroduce them into discovery or account binding. The
remaining Pro Low recipe retains its own operating profile.

Alias publication is independent of generation. The optional `published` field preserves old
exact-alias defaults; wildcard and strategy identifiers never become selectable directory IDs.
Automatic targets default hidden and require an explicit rule. A public automatic alias can
disappear while the eligible pool is empty. Independently advertised physical IDs survive a
hidden-alias collision, retaining physical metadata if an automatic target cannot resolve.

Automatic selection uses the existing lease owner's read-only eligibility evidence, not the
directory or a refresh. It freezes a physical target once per generation/count request so retries
cannot silently change model families or tiers. Opus strategies stay within Opus. Flash defaults
to Low while preserving explicit requested tiers and registered recipes. No-evidence fixed
fallbacks and implicit replacement of existing mappings were rejected because they obscure
entitlement and override user intent. Owner compatibility `14` prevents a mixed desktop/Core
pair from dropping the new management field. See the
[same-release upgrade guide](../../../../docs/upgrade-guides/next/desktop-core-project-id.md).

## Alternatives considered

A process-wide rejection flag and catalog-as-entitlement shortcut were rejected:
they suppress healthy accounts and turn discovery data into an unverified
permission claim. Blind suffix replacement was also rejected because distinct
physical model identities can share a textual suffix.

## Consequences

The gateway may continue to show a model in a directory while a specific account
is temporarily avoided for that model. The failure remains diagnosable and
expires or clears on matching success. Exact route precedence and account-local
availability are now testable independently.

## Rationale

The routing policy handles exact, wildcard and tier matches. Account
availability is tracked separately. This prevents one account's
missing model entitlement from suppressing a model for every other account and
prevents a public directory from being treated as proof that generation will
succeed.

## Verification

Focused routing, capability, model-variant and protocol-path tests passed. The
stage report is D08 routing and availability implementation (local artifact `D08-routing-availability-implementation.md` in the 2026-10-11 review collection).

Live-provider and packaged-client checks remain deferred until the full D01–D29
stage is complete.
The 2026-11-07 provenance and tier-binding changes were independently source-reviewed. That review fixed legacy public recipe fallthrough on physical targets and a Gemini count effort mismatch. Earlier passing evidence above predates this snapshot. Tests, test edits, type checks, lint, builds, formatting, check scripts and live operations are explicitly deferred by the user. See the current source implementation report (local artifact `D08-explicit-tier-binding-implementation.md` in the 2026-10-11 review collection).

The user subsequently requested tests and approved the 2026-11-10 D08 grouped
implementation. The earlier test deferral describes that historical stage.
Current checks cover route precedence, account-specific High IDs, directory
agreement, supported Claude suffixes and headers, plus preserved image options
through physical model binding. See the current task record (local artifact `scope-decisions.md` in the 2026-11-07 review collection).

D22 checks cover publication migration, saved Core RPC readback, shared list/detail/probe
visibility, empty-pool failure, account-local eligibility, physical-target freezing on retry and
model-specific headers through all three generation protocols. An isolated Windows Electron
renderer verifies the actual mapping controls with injected IPC; provider responses remain
substituted in the protocol suite. OAuth regression uses a real loopback listener and an
injected enrollment failure. See the D22 evidence record (local artifact `d22-implementation.md` in the 2026-11-07 review collection).
Credential-backed provider and Google login acceptance remain unverified.

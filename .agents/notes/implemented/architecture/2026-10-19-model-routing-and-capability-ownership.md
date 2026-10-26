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
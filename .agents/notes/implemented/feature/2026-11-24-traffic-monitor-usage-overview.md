# Agent Note: Traffic Monitor usage overview

Status: implemented

## Problem

The request list and recent minute trends answer individual diagnostics. A developer
investigating a longer usage spike also needs period totals, account and model
attribution, session navigation, and cache coverage.

## Decision

Add a bounded, read-only operation to the selected audit owner. It calculates
totals, time buckets and rankings from one retained snapshot. Drill-down preserves
the request-start interval and the independent attempt observation cutoff. Exact
account and model filters apply to the same generation attempt.

The existing minute trends and quota-cycle policies keep their own contracts.
Overview estimates use local user-entered rates and count their priced attempts.
Extended analysis uses the saved request cohort for speed and observed clients.
Context composition reads an existing sanitized body on demand and reports bytes,
while token estimates and transport observations retain distinct provenance.
Transfer counters extend the existing timing envelope with optional observations
so historic timing and absent bytes remain readable without database migration.

## Alternatives considered

- Aggregate renderer pages. This leaves off unloaded results and cannot recover
  the identities of earlier attempts from the parent row.
- Import external agent logs into the retained audit store. External logs have
  independent identities, retention and privacy requirements. This surface uses
  the audit owner's gateway observations.
- Derive attempt filters from the final account or model. A fallback request can
  contribute usage to multiple groups, so drill-down needs the exact attempt.

## Consequences

Desktop and standalone Core require the same owner compatibility version. The
audit storage and account formats stay unchanged. Price settings are
renderer-local. Rankings have bounded detail and do not set overall totals.

## Verification

The [repository test](../../../../src/tests/unit/audit-usage-range.test.ts)
exercises retries, missing usage, price coverage and exact attempt drill-down.
The [owner test](../../../../src/tests/unit/audit-owner.test.ts) exercises the
selected desktop and standalone operation and transport.

# Agent Note: Model family account priorities

Status: implemented

## Problem

A single account priority cannot express different preferences for Gemini and Claude while leaving
existing routing rules and live session affinity in place.

## Decision

Persist optional Gemini and Claude overrides in two nullable account columns. The selected owner
saves the routing form in one write and updates the gateway's cached routing fields. Owner
compatibility 19 coordinates the account view and mutation across desktop and standalone Core.
Priority follows the resolved upstream route for each candidate. Omitted overrides in older
mutation calls preserve stored values. An empty override object clears both values.

## Alternatives considered

- Separate account pools for each provider would require duplicating eligibility and session rules.
- Classifying by the requested alias can apply the wrong family priority after account-local routing.

## Consequences

Legacy account rows keep the global priority. Older releases use the global value. Accounts with
overrides still enter the usual availability checks before selection. See the [same-release guide](../../../../docs/upgrade-guides/next/desktop-core-project-id.md).

## Verification

The focused selector tests cover both schedulers, alias resolution and global fallback. The SQLite
test exercises startup migration, complete and omitted writes, clearing and credential readback.

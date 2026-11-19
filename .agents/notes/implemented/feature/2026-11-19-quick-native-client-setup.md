# Agent Note: Unified coding tool setup

Status: implemented

## Problem

Gateway setup, connection editing and recovery had separate entries for the same client.
Some clients required the user to choose settings that the gateway could supply.

## Decision

The gateway lists each tool once, with **Set up** for the current gateway defaults
and **Manage** for connection changes and recovery. The renderer delegates native
writes to existing owners. Native backup formats, saved connection identifiers and
credential snapshots remain in their owning features.

## Alternatives considered

Moving existing connections into a new catalog would require migration of native
ownership records and recovery data. The unified entry can compose the existing
owners and preserve their behavior.

## Consequences

Quick setup selects text models from eligible accounts with observed quota. OpenCode
leaves account export off. DSH uses its initialized web profile by default. A missing
Manager key is shown before users attempt setup for tools that require it. A saved
configuration and a successful request are separate outcomes.

## Verification

Renderer checks cover a single entry per tool, scoped saved connections, quick writes
and recovery. The existing owner checks cover stale source hashes and native writes.
See the [tool configuration reference](../../../../docs/modules/proxy-gateway/agent-tools.md).

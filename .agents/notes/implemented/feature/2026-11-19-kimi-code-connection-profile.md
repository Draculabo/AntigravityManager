# Agent Note: Kimi Code connection profile

Status: implemented

## Problem

Kimi Code needs a native provider and model entries to use Manager's gateway.
Users need to review those writes and recover their existing selection.

## Decision

Use a native Kimi Code CLI 2.x adapter with the documented OpenAI Chat provider.
The adapter supplies field edits to the existing profile owner, which retains
credentials, previews and receipts. Only explicit activation claims the default
model field. Extend the strict owner contract and reject mixed owner versions.

## Alternatives considered

Using the client vendor's native provider type would introduce vendor-specific
behavior into a connection that uses the existing OpenAI Chat protocol. Embedding
the configuration writer in the renderer would move credential access across an
additional process boundary.

## Consequences

Independent profiles have distinct provider and model aliases. The existing TOML
writer preserves values and reserializes the document. Its encrypted first backup
preserves the original text. Catalogs containing the new client require a matching
owner. See [connection profiles](../../../../docs/modules/proxy-gateway/agent-tools.md#kimi-code-provider)
and the [upgrade guide](../../../../docs/upgrade-guides/next/connection-profiles.md).

## Verification

The focused profile test exercises preview, provider and model application,
explicit default activation, and native field recovery on removal. It also
checks refusal when a stale preview or a dangling default would make the
write unsafe. The isolated Windows live check uses Kimi Code 2.7.0 and the
Core owner to verify real generation, tool output and configuration recovery.

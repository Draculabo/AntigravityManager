# Upgrade guide: Replace retired Antigravity model IDs

Target version: next

## Affected users

This affects clients and gateway aliases that reference `gemini-pro-agent` or
`gemini-3.1-pro-high`. Those IDs now return HTTP 404 and disappear from the
gateway model directory, including raw quota mode.

## Required action

1. Refresh your client's model list and select a model available to your account.
2. Update any saved gateway aliases and client defaults that reference the retired IDs.
   Run OpenCode sync again if you use the Manager-managed provider.

## Data and recovery

Existing account quota records, traffic history and saved gateway aliases are preserved.
Correct an affected alias in the gateway settings to resume using it.

## Downgrade

No storage restoration is required. An older gateway can still list the retired IDs
from its presets or cache, but a downgrade cannot restore upstream access.

## Verification

The routing HTTP tests cover stale provider catalogs, affected aliases, rejection before
account selection and a successful request to Gemini 3.1 Pro Low in a controlled fixture.

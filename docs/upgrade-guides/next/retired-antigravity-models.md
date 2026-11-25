# Upgrade guide: Replace retired Antigravity model IDs

Target version: next

## Affected users

This affects clients and gateway aliases that reference `gemini-pro-agent`,
`gemini-3.1-pro-high`, Gemini 1.x or 2.x text models, or Claude versions earlier
than 4.6. Direct requests to those models return HTTP 404 and raw quota discovery
omits them. The gateway uses the account catalog once it has model data.

## Required action

1. Refresh your client's model list and select a model available to your account.
2. Update any client defaults and gateway alias targets that reference a retired model. A
   configured alias can keep the old request name and point to an available target.
3. Run OpenCode sync again if you use the Manager-managed provider.

## Data and recovery

Existing account quota records, traffic history and saved gateway aliases are preserved.
Correct an affected alias in the gateway settings to resume using it.

## Downgrade

No storage restoration is required. An older gateway can still list the retired IDs
from its presets or cache, but a downgrade cannot restore upstream access.

## Verification

The routing HTTP tests cover stale provider catalogs, rejection before account selection,
explicit aliases for older request names, and routing of account-advertised model IDs in a
controlled fixture.

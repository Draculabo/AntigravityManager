# Upgrade guide: Review explicit model replacements

Target version: next

## Affected users

Users with an enabled exact model alias and a runtime retirement rule for the
same request name now use their configured target. Equivalent case-folded and
Claude-normalized exact aliases have the same priority. Runtime retirement still
precedes wildcard rules.

## Required action

Review explicit replacements in model settings before upgrading. Keep an alias
when its configured target is intentional. Disable it to follow the provider's
runtime replacement instead. After upgrading, inspect the request's resolved
model in the traffic audit and query the alias through the model directory.

## Data and recovery

This change reads existing configuration without converting or writing it.
Recovery from an unavailable configured target consists of correcting or disabling
the affected rule. The gateway reports the failed request through its ordinary
error response. Existing account, credential and conversation records are
unaffected. No backup restoration procedure is required by this change.

## Downgrade

Earlier versions apply their former retirement-first routing order. Existing
configuration remains readable. Check the resolved target again after a downgrade
because an enabled exact rule can resume yielding to a runtime replacement.
Cross-version execution against a live provider has not been exercised.

## Verification

Routing tests exercise exact replacements, wildcard precedence and conflicting
equivalent rules. HTTP tests compare metadata with the actual request sent through
the upstream client to a loopback fixture. See the [compatibility reference](../../modules/proxy-gateway/compatibility.md)
and [decision](../../../.agents/notes/implemented/architecture/2026-10-19-model-routing-and-capability-ownership.md).

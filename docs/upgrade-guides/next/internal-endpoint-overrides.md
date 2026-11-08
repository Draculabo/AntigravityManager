# Upgrade guide: Correct internal endpoint overrides

Target version: next

## Affected users

Operators who configure `PROXY_INTERNAL_BASE_URLS` or `ANTIGRAVITY_INTERNAL_BASE_URLS`.
Default routing and public Gemini/OAuth endpoints do not require configuration changes.

## Changed behavior

Internal candidates are now validated before explicit cache creation or generation. The
selected value is limited to 8 KiB and eight comma-separated absolute HTTP(S) URLs.
Credentials, query, fragment, backslash, control characters and empty entries are rejected.
URLs are normalized and deduplicated in configured order. Root URLs retain a slash before
the method suffix. Absent or blank selected values use Daily/Sandbox/Prod. A present primary
variable still takes precedence over the alias, including when blank.

Invalid configuration stops the operation; it does not try other accounts or return a
local count estimate. The error message does not include the configured values.

## Required action

Remove unused candidates and supply valid endpoint base URLs, such as
`https://daily-cloudcode-pa.googleapis.com/v1internal`, or remove the override to use defaults.
Keep OAuth tokens in their existing authentication contract, rather than URL credentials.
Restart the process after changing its environment.

## Data and recovery

Correcting the environment is sufficient; no persisted data migration is involved.

## Downgrade

Older builds do not enforce these bounds and can repeat malformed or duplicate candidates.
Do not restore a known-invalid override when rolling back.

## Verification

Controlled transport and service checks cover failure and corrected valid routing;
installed/live-provider recovery is unverified. See the
[architecture reference](../../architecture.md) and
[decision](../../../.agents/notes/implemented/bug-fix/2026-11-05-internal-endpoint-configuration.md).

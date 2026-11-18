# Upgrade guide: Preserve custom generation deadlines

Target version: next

## Affected users

Users who set `proxy.request_timeout` to limit model generation must move that limit to
`proxy.generation_timeout`. Existing profiles otherwise receive a 270-second generation
budget. The old field remains the non-generation transport and account-maintenance limit.
The gateway timeout control now changes the generation budget.

Empty-thinking continuation is enabled when `proxy.experimental.thinking_only_recovery`
is absent. An explicit false remains effective. A qualifying response can incur one extra
upstream send; it does not change the selected model, tools or thinking budget.

## Required action

1. Record any custom request limit before upgrading.
2. After upgrading, set the API Proxy timeout control to the intended generation limit.
   The equivalent configuration field is `proxy.generation_timeout`, in whole seconds
   from 1 through 3600.
3. Keep `proxy.request_timeout` at the intended non-generation transport limit. To suppress
   empty-thinking continuation, set `proxy.experimental.thinking_only_recovery` to false.

## Data and recovery

Accounts, credentials, responses and thought records retain their formats and locations.
No credentials are rewritten. Configuration loading supplies the new default without
guessing whether an old 120-second value was deliberate. Management updates persist the
selected generation limit and preserve fields omitted from a patch. A failed configuration
write remains governed by the existing configuration service recovery contract.

## Downgrade

Older builds do not use `generation_timeout`. Before downgrading, set `request_timeout`
to the desired old generation limit and explicitly set thinking-only recovery to false
if the earlier disabled default is required. Older configuration writers may drop the new
field. Native downgrade was not exercised for this change.

## Verification

The generation policy tests exercise a response arriving after 120 seconds, the initial
180-second silence cutoff and the 270-second absolute cutoff. Configuration boundary tests
check legacy loading, valid updates and preservation on unrelated patches. Real-provider
acceptance is separate from those deterministic checks. See the
[current timeout and recovery contract](../../modules/proxy-gateway/compatibility.md) and
[thinking continuation](../../modules/proxy-gateway/stream-tool-compatibility.md).

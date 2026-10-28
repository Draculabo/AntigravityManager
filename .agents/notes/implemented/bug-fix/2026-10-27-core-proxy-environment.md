# Agent Note: Preserve proxy routing across detached Core launches

Status: implemented

## Problem

The detached Core environment allowlist excluded proxy routing variables. Setting a proxy on
the CLI therefore did not provide it to the Core or an official client launched by that owner.
A live unsupported-location investigation exposed this difference between a Manager-owned
launch and a direct official-client launch. That provider rejection does not itself establish
that forwarding a proxy will make the account or exit address eligible.

## Decision

The [detached launcher](../../../../src/cli/service-launcher.ts) retains only the standard HTTP,
HTTPS, all-protocol and bypass variables, in both uppercase and lowercase, alongside its existing
allowlist. It copies their values without normalization or precedence resolution. The owning
request client continues to interpret proxy URLs and bypass rules.

Proxy URLs may contain authentication material. They remain in the trusted parent-to-child
environment and are not added to arguments, public transports or diagnostic logs. Unrelated
secrets, `NODE_OPTIONS` and `NODE_PATH` remain excluded.

## Alternatives considered

- Inheriting the entire environment would weaken the existing isolation and permit Node injection.
- Passing only uppercase variables would drop valid lowercase routing and bypass settings.
- Rewriting proxy values or choosing one casing in the launcher would duplicate client policy.
- Changing system proxy settings or the official endpoint would introduce unrelated shared state
  and would not repair the demonstrated CLI-to-Core loss.

## Consequences

CLI and desktop launches that use this detached launcher preserve the same routing inputs as
their parent. An already-running Core retains the environment from its own launch and needs a
restart to receive changes. No persisted format, account credential or system proxy is changed.
Removing the added allowlist entries restores the previous filtering behavior.

## Verification

- [Launcher tests](../../../../src/tests/unit/service-launcher.test.ts) cover both casings together,
  distinct values, empty bypass values and continued exclusion of arbitrary secrets and injection.
- [Process tests](../../../../src/tests/unit/service-process.test.ts) verify routing and bypass
  variables at the actual launcher-to-`spawn` call boundary while preserving the no-app-launch guard.
- An isolated Node 24.22.0 probe bundles the current launcher and starts disposable file-writing
  children. Before the fix, both casing variants lost all proxy fields; after the fix, both
  preserve routing and bypass values while excluding injection and unrelated secrets. The probe
  uses synthetic values and does not launch an official client or contact a provider.
- On 2026-10-28, a fresh CLI/Core build passed one isolated official IDE generation using account A,
  Gemini 3.8 Flash High and the configured upstream proxy. Credential readback, Google identity and
  official identity passed. The CONNECT observer attributed Prod and Daily proxy connections to the
  language-server process, and the official logs contained no unsupported-location precondition.
  Configuration and the original Windows credential were restored; independent cleanup found no
  official-client, language-server or test Core processes. This single request does not establish
  eligibility for other accounts, models, exit addresses or network conditions.

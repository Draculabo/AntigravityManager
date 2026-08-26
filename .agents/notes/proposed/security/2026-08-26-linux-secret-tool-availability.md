# Agent Note: Linux secret-tool availability detection

Status: proposed

## Problem

The Linux credential writer selects the Secret Service-backed `secret-tool` store only when an executable probe succeeds. Some supported `secret-tool` builds do not implement `--version`: the executable is present, but that option exits non-zero. Treating that exit as absence incorrectly writes credentials to the native keyring instead, splitting credential authority between the two stores.

## Proposal

Probe `secret-tool` with no arguments and treat a successful process spawn as availability, regardless of its usage exit code. Keep the bounded three-second timeout. Treat spawn errors, including `ENOENT`, as unavailable and retain the native-keyring fallback.

## Alternatives considered

- Keep the `--version` probe: rejected because version-flag support is not a capability requirement for secret lookup or storage.
- Require an exit code of zero from a no-argument probe: rejected because a usage exit is expected when no subcommand is supplied.
- Attempt a credential lookup to test availability: rejected because it can conflate executable availability with locked, unavailable, or missing credential states.

## Acceptance criteria

- A non-zero no-argument usage exit still selects `secret-tool` for Linux writes.
- A spawn error falls back to the native keyring.
- The existing read precedence remains `secret-tool` first, native keyring second.
- The probe stays bounded by a three-second timeout.

## Risks

A runnable but malfunctioning executable may be considered available; the subsequent `secret-tool store` operation remains authoritative and falls back to the native keyring if it fails. Mocked tests do not validate a real Linux Secret Service session, locked collection, or OS keyring implementation.

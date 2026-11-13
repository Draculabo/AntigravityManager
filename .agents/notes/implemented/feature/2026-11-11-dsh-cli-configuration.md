# Agent Note: DSH configuration from the Manager CLI

Status: implemented

## Problem

The desktop can configure a DSH profile through the selected Core owner, while the standalone
Manager CLI lacks the corresponding commands. Headless users need the same preview and conflict
checks without editing the provider or credential files themselves.

## Decision

`tools dsh` exposes status, preview, apply, and remove through the existing DSH Core operations.
Each command requires a profile. Apply and remove require `--yes` and the source hash returned
by a reviewed preview. Input parsing runs before Core startup. The existing owner controls
file locking, backups, credentials, writes and readback.

Results are validated against the existing strict schemas before JSON output. Errors expose
the allowlisted DSH category and recovery guidance. Invalid command input and Core failures
cannot echo arbitrary arguments, provider content or credential values.

## Alternatives considered

- Reimplementing profile edits in the CLI would duplicate credential and concurrency policy.
- Automatically previewing and applying in one command would remove the user's chance to
  inspect the requested credential and default-model changes.

## Consequences

Existing Core RPC supports these operations. The CLI uses the selected owner's `DSH_HOME`.
An existing-reference credential remains DSH's responsibility. Manager-key provisioning uses
the owner's existing supported-store checks. A partial write or stale source requires inspection
or a new preview before another explicit attempt.

## Verification

- CLI tests cover option validation before startup, strict results and sanitized failures.
- A real local Core endpoint with isolated profile files exercises preview, stale apply,
  successful apply and removal while preserving a personal provider.
- The installed DeepSeek Harness loads the generated isolated profile with `--dump-config`.
  Its composed configuration contains the Manager provider, model and gateway address.
  Credential-backed generation remains a separate live acceptance step.

# Agent Note: Linux Secret Service collection synchronization

Status: implemented

## Problem

On Linux, Secret Service can expose separate `login` and default collections. External Antigravity CLI consumers may resolve the `login` collection while this application's existing reader first resolves the default Secret Service entry. Writing only the default collection can leave an external CLI on a stale account; treating a successful login write as sufficient can leave the application's established read path stale instead.

## Decision

When `secret-tool` is available on Linux, write the existing credential payload to `login` first and then to the default collection. Both writes keep the existing ten-second process timeout and pass the secret through standard input rather than command arguments.

The default collection remains the compatibility gate: a successful default write retains the previous success behavior even when the login write fails. A failed default write still falls back to the native keyring, including when the login write succeeded, because the in-app reader continues to rely on the default path. Logs record only collection outcome metadata; raw credential payloads, `secret-tool` stderr, and transport errors are not logged.

## Alternatives considered

- Writing only `login` would follow one external consumer but could leave the current default-first reader on an old credential.
- Accepting either collection as complete success would change the prior default/native fallback contract and could make an account switch appear successful while the application still reads the old value.
- Adding a generic OpenCode provider descriptor was rejected because the repository has only one managed provider. The module ownership rules require a real second consumer before introducing shared infrastructure.

## Consequences

Linux systems may hold equivalent credentials in both Secret Service collections and may prompt or fail independently for each target. If the default collection or both collections cannot be written, native keyring behavior remains the recovery path; if that also fails, the switch fails before the CLI file is updated. Read precedence, credential payload format, SQLite storage, and renderer exposure are unchanged.

## Verification

Mocked Linux tests cover successful dual writes, login-only failure, default failure with native fallback, dual failure, unavailable `secret-tool`, and timed-out writes without raw error logging. Existing read-precedence tests continue to verify secret-tool/default preference and native fallback. Real Linux D-Bus, keyring prompts, and external CLI collection resolution require platform verification and are not claimed by unit tests.

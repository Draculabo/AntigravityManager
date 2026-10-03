# Agent Note: Initialize missing desktop identity storage

Status: implemented

## Problem

Windows account switching can write credentials, then fail with `storage_json_not_found` and leave Antigravity closed. Newer credential-store-backed Hub installations can complete onboarding without creating the legacy identity file. Requiring another first-run walkthrough does not resolve this condition.

## Decision

The identity-profile module owns explicit initialization. Account addition and imports resolve the desktop target and directory, while GUI switch preflight uses the captured launch directory. WSL native Linux installations do not inherit Windows directory defaults during initialization. When no executable is available, account collection prepares the host's native profile; conflicts and query failures are not swallowed. Read operations remain pure. Missing files receive generated identifiers through atomic exclusive publication; existing JSON objects are validated without replacement. Invalid or inaccessible storage remains an error.

GUI switching applies the profile before injecting credentials for both storage strategies. This prevents a profile application failure from following successful credential injection. A missing bound profile and storage preflight errors are reported before shutdown. Required SQLite state continues to use the existing writer. CLI operations retain their separate credential-store contract.

## Alternatives considered

- Copying example identifiers from an issue comment would share a fingerprint across users.
- Initializing inside `getStoragePath` would make status and identity queries mutate the application profile.
- Skip identity storage preparation for credential-store targets: rejected because profile application can still depend on that file and fail after shutdown. Explicit preflight initialization preserves actionable errors for corrupt or inaccessible storage.
- Replacing a malformed file would discard application settings and hide corruption.

## Consequences

Initialization adds an identity sidecar to installations that did not create one. This does not prove newer Hub versions consume legacy telemetry identifiers. No changes are made to Hub authentication formats. A failure after shutdown can still leave the application closed; the switch reports the failing stage without retrying launch or claiming success.

## Verification

- Focused filesystem tests cover complete generated identifiers, idempotence, preserved fields and BOM, invalid JSON, concurrent publication and access errors.
- Switch tests cover preparation before shutdown, captured paths, profile application before credential injection, and no credential writes on preparation or profile failures.
- Windows focused tests pass (90 tests across nine files); WSL Ubuntu focused tests pass (79 tests across seven files). Type checking, focused lint, formatting, governance checks and whitespace checks pass.
- Windows `npm run start` acceptance creates the missing file and activates a real account in 5.9 seconds. After a second real OAuth account is added, the A-to-B and B-to-A flows complete in 3.0 and 6.7 seconds, with native process replacement and the Manager's active account matching each target.
- An earlier attempt fails during process shutdown confirmation while the system drive has no free space. It does not inject the destination credentials. Retesting after disk space is restored succeeds. The official application's own account display and a real-account WSL switch remain unverified; Manager state and process confirmation do not establish those separate observations.

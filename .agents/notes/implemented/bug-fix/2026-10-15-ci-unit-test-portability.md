# Agent Note: Portable CI unit test fixtures

Status: implemented

## Problem

The Tests workflow failed at `b516b297` with 33 failed tests across 13 files on Ubuntu, while type checking passed. The preceding `8f6d2e38` run reported the same failures. Local focused checks had not exercised all affected consumers or the Linux suite. The new hook integration command was included in `check:ci`, but the actual workflow called individual commands and did not execute it.

## Decision

- Bound Vitest to four workers instead of sizing concurrent module loading from the host CPU count. Keep existing operation and test timeouts. Replace the stale auto-switch IPC mock with the current switch-service boundary so quota tests do not load the unrelated switching dependency graph.
- Run the existing unit and acceptance harness suites with Node 22 on both Ubuntu and Windows. Add the installed-hook integration command to the actual Tests workflow and explicitly select Vitest run mode.
- Exercise Windows-only policies by selecting the platform in the fixture and restoring it during teardown. Preserve host-valid filesystem paths when testing policy rather than Windows path normalization. Mock client discovery in owner-routing tests instead of depending on an installed application.
- Complete security initialization mocks and materialize synthetic backup files before testing their POSIX permissions. Give socket fixtures private parent directories and await listener cleanup before deleting them.
- Update expectations for CONNECT agents, named function restrictions, schema admission errors and NSIS metadata to the current owning contracts. Retain complete output assertions and real loopback HTTP evidence. The CONNECT rejection test retains a plaintext-forwarding tripwire and checks that authorization is absent from the tunnel handshake.
- Submit only changed local fields in the offline preferences case, matching `splitSettingsChange`. Explicit error-reporting updates still require their owner effect and are covered separately.
- Contain accepted profile-owner socket errors at the connection: destroy the failed socket and retain the listening lease. A liveness probe can disconnect before reading; that peer failure must not become an uncaught exception or relinquish profile ownership. Binding and acquisition failures retain their existing failure behavior.

- Create the runtime-trace fixture parent on clean checkouts. Disable signing only inside synthetic Git repositories so developer signing configuration does not require credentials during harness tests. A fixture regression explicitly inherits signing requirements and verifies commit and tag creation.

## Alternatives considered

**Skip platform-dependent failures on Ubuntu.** This would remove policy coverage rather than make the fixtures portable. Native behavior still requires native evidence, but Windows policy can be exercised with isolated filesystem and discovery inputs.

**Restore old production behavior to satisfy old assertions.** Absolute-form HTTPS proxy forwarding, missing named-function restrictions or incorrect schema error categories are not the current contracts. Tests follow the owning implementation and documented behavior while continuing to check the full relevant result.

**Run the entire suite in every local Git hook.** The baseline hooks remain narrow. Known CI failures require reproducing the failed selection and then running the affected platform's full unit suite; a focused pass cannot certify all tests.

## Consequences

The Tests workflow validates both development platforms and directly invokes its hook tests. It does not establish packaged application, real account, native keyring or live-provider behavior. Policy mocks and real platform filesystem evidence are reported separately. The profile-owner listener remains authoritative after an individual connection fails.

## Verification

Before the fixes, the original 13-file selection reproduced all 33 CI failures under isolated Ubuntu with Node 22.23.3, and 9 failures on Windows. A deterministic reset injection on a real accepted profile-owner socket failed before the connection error handler was added. The corrected Windows selection passed all applicable cases, and the remaining Classic/profile-lease Linux selection passed all 25 cases.

The complete Ubuntu suite with Node 22.23.3 passed 435 files, with 3310 tests passed and 4 skipped. Its acceptance harness passed 68 tests, Git hook integration passed 11 tests, governance passed 21 tests and both boundary checks, and type checking passed.

The subsequent auto-switch mock correction passed all 17 cases on Ubuntu and Windows; its Windows first-test load fell from a timeout above 5 seconds to about 0.3 seconds.

Windows acceptance harness tests passed 68 cases, governance passed 21 cases and both boundary checks, and type checking passed. Windows Git hook integration passed all 11 tests. The complete Windows Node 22.23.3 unit suite passed 435 files, with 3310 tests passed and 4 skipped in 482.85 seconds.

Changed code passed focused ESLint and Prettier checks, and the final semantic review found no additional defects. These are local source and harness results; the changed workflow has not run remotely, and packaging, real accounts and native keyring acceptance are outside this change.

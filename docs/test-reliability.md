# Test and Acceptance Reliability

Use this reference when adding or changing asynchronous tests, subprocess fixtures, network listeners, native checks or acceptance scripts, and when investigating intermittent failures. [Testing strategy](testing.md) selects the required evidence; this document defines how that evidence remains trustworthy.

## Establish the execution environment

Read the owning test configuration, launcher and CI job before choosing isolation and timeout behavior. Account for overlap between tests, worker processes, independent runner invocations and jobs sharing a host. A sequential test file does not isolate host ports, OS credentials, installed applications or shared directories from other processes.

For each acquired resource, identify its owner, unique allocation, readiness signal, completion signal and cleanup. Use the existing runner from [repository scripts](../scripts/README.md) when it exercises the affected production path. Source tests, built Node entries and packaged Electron executables establish different evidence; record the actual entry and matching native ABI.

## Isolate resources and restore state

- Bind synthetic loopback servers with port `0` and read the assigned address after listening. Avoid checking a free port and acquiring it later. Where an official client requires a configured debugging port, use its owning SOP, check for conflicts and keep that runner exclusive.
- Allocate writable fixture directories atomically with `mkdtemp`. Keep parser examples and expected paths separate from directories actually acquired by a test.
- Namespace databases, sockets, reports and profiles per run. Resolve cleanup paths and verify they remain inside the owned temporary root before recursive removal.
- Prefer injected dependencies over global mutation. When changing environment variables, working directory, timers or hooks, register restoration immediately and preserve the difference between absent and present values.
- Isolated Chromium profiles do not isolate the Windows OS credential store. Live account acceptance follows the [account-switch SOP](account-switch-acceptance.md), captures the original credential before any write and verifies exact restoration. A missing backup prevents the write; a cleanup failure fails acceptance.
- Preserve evidence of failure without exporting credentials, account identities or private profile contents. Temporary-state cleanup does not authorize deleting unrelated installations, user directories or repository worktrees.

## Wait for observable state

Use readiness events, handshakes, owned promises or a bounded observation of the state under test. A fixed sleep does not establish readiness or successful persistence. When testing a race, use barriers or deferred promises to place operations at the contested transition and demonstrate overlap.

Give the operation, setup and cleanup explicit deadlines appropriate to the active runner. Keep the outer test deadline larger than the timeout being tested so that the intended failure can be observed. When time is the behavior, inject a clock or use scoped fake timers and restore them.

Register cleanup as each resource is acquired, including on failed assertions. Stop new work, cancel owned operations, detach listeners and await server close, worker termination or child exit. A request to abort, close or kill is not evidence that callbacks and writes have stopped. Forced termination can clean up a disposable fixture; it cannot establish that a real application saved state during normal close.

## Respect platform behavior

Observe OS-owned values after writing them when the test depends on round-trip fidelity. Windows environment names are case-insensitive, timestamp precision differs by filesystem, and open handles can delay file replacement. POSIX signals and permissions are not Windows behavior. Use a narrow platform condition with a reason when a scenario cannot run there; report the missing platform evidence.

Use bounded retries only for identified contention or a documented external-provider policy. Changing the timeout, retry count, assertion or worker count without explaining the failing state does not resolve an intermittent failure.

## Demonstrate the regression

Observe the original behavior fail before the fix when practical. For a new validation rule or acceptance predicate, introduce a representative invalid fixture and confirm rejection through the actual runner. A successful report alone does not establish that the script can detect a defect.

Assert external results such as persisted fields, observed identity, protocol output, child exit or resource release. For a cross-process isolation fix, run independent fixture processes concurrently. Repeated execution can supplement a deterministic regression but cannot replace controlled overlap or readiness evidence. Check the selected test count and exit status; a filter selecting no tests establishes no behavior.

## Investigate intermittent failures

1. Preserve the exact command, selected test, commit, platform, runner/job, timing and first stable failure signature. Keep infrastructure messages separate from product or assertion errors.
2. Compare failures and successes at the same revision, or verify that the relevant source and runner configuration are unchanged. A passing rerun does not identify the original cause.
3. Classify from evidence: shared resource collision, incomplete cleanup, global-state leak, readiness assumption, platform or source/build mismatch, product race, external-provider failure or runner infrastructure.
4. Reproduce the smallest relevant environment: one file, concurrent files, independent runner processes, then the owning CI job. Increase scope only to reproduce the original signature. Use platform CI when the local host cannot reproduce the affected OS.
5. Fix the owner of allocation, readiness, mutation or cleanup. Verify the regression and applicable restoration, concurrent-process and termination evidence. Report unresolved causes and platform gaps explicitly.

An investigation is complete when the original signature has a supported explanation, a fix has matching regression evidence when authorized, and cleanup and environment limitations are reported. Diagnosis-only work remains read-only.

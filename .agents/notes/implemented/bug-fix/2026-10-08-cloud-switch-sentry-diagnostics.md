# Agent Note: Cloud switch Sentry diagnostics

Status: implemented

## Problem

Sentry issue 7778471741 groups cloud-account switch failures under a fixed ORPC error. A related
event identifies a target write failure, but nested recent log objects normalize to `[Object]`
at the SDK's default depth. The owner's failure record also omits the stage and native category.
Issue 344 later showed that the desktop public IPC wrapper also discarded the validated switch
category, so renderer notifications and copied bug reports collapsed every classified failure into
the generic fallback.

## Decision

Recent logger context uses formatted strings. The existing bug-report text redactor lives in
shared observability and also handles Sentry logger text and encoded keyring payloads. The account
owner records closed stage/target/storage/flow categories and an allowlisted native error code.
Credential readback mismatch has a fixed diagnostic category. IPC messages and switch codes
retain their existing contract; the public desktop envelope reparses the feature-owned closed schema,
strips unknown fields and copies the category into the generic diagnostic detail. Raw causes are not
added to that contract or the failure record.

## Alternatives considered

- Raising SDK normalization depth affects every event's traversal and payload size. Flat text
  resolves the known logger-context loss without changing global normalization.
- Attaching raw native errors or commands can reveal credential material. Safe categories retain
  the distinctions needed for diagnosis without publishing provider text as switch metadata.

## Consequences

Future reports identify the failing preparation stage or flow reason. Unknown native errors
remain `unknown`, and old truncated events cannot be reconstructed. This change does not alter
credential storage, write verification, process control or retry policy, and does not establish
the root cause of the reported native write failure. Existing Issue 344 data cannot recover the
category that version 0.25.0 discarded.

## Verification

Focused tests exercise production reporter wiring with the actual SDK normalizer, text redaction,
native error category filtering and remote switch error behavior. Before the implementation,
the reporter/owner regressions fail with `[Object]` and missing or incorrect categories. The public
IPC regression also verifies that the switch category and generic diagnostic code survive while
unrecognized data is removed.
Native credential write acceptance remains platform-dependent.

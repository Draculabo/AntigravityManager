# Agent Note: Prevent geography enrichment in isolated Sentry diagnostics

Status: implemented

## Problem

Schema diagnostics must not inherit account, request or user context. Real SDK envelopes omit
user data, but the exact remote events contain nonempty `user.geo`. Disabling SDK automatic
integrations and `sendDefaultPii` does not prevent service-side inference from a connection IP.

## Decision

The shared isolation helper replaces user data with `{ geo: {} }`. It keeps removing request,
breadcrumbs, contexts, extra and exception fields. Both Node core and Electron beforeSend hooks
use the helper. Events outside isolated diagnostics retain their existing behavior.

The [official Relay normalization source](https://github.com/getsentry/relay/blob/master/relay-event-normalization/src/event.rs)
returns from `normalize_user_geoinfo` when an explicit geo value is present. Otherwise it may
use the submission IP even when the event has no user IP. The
[official Geo schema](https://github.com/getsentry/relay/blob/master/relay-event-schema/src/protocol/user.rs)
accepts an empty object. The object carries no location or identity value.

## Alternatives considered

- Deleting user data alone: disproved by matching outbound envelopes and remote event IDs.
- Supplying a dummy IP: unnecessary identity data and a less precise way to prevent enrichment.
- Weakening the remote check to ignore geo: would conceal the observed storage violation.
- Changing global project scrubbers: affects unrelated reports and requires a separate project
  administration decision. No settings are changed for this fix.

## Consequences

Isolated outbound events contain only an empty user geo object. Normal reporting, consent,
Schema error classification, account selection and quota behavior are unchanged. This uses
provider normalization behavior rather than a universal SDK privacy guarantee; upgrades must
retain the exact-event remote storage check. No raw event bodies or actual geography are exported.

## Verification

The isolation regression fails before the fix and passes afterward, with inherited email,
geo and account data replaced. A separate case preserves ordinary reports. The real SDK local
receiver requires the exact empty user override. A candidate event sent to the configured service,
`ac3325c4ebfb40289dbca3e8144731c1`, is received at `2026-10-08T12:35:33.929000Z`; the unchanged
strict event-detail check finds no nonempty user fields or unsafe entries. The subsequent real
gateway evidence belongs in the local live verification record (`artifacts/schema-work-package/live-verification.md`).

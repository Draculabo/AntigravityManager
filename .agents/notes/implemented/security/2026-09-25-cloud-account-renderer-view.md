# Agent Note: Cloud Account Renderer View

Status: implemented

## Problem

The cloud-account list contract returned the persistence account model through Electron's MessagePort. Its runtime schema included account tokens, device state and proxy URLs, so renderer code could receive secrets it did not need for account cards and quota displays. A proxy URL can contain userinfo credentials, and provider status or verification fields can contain sensitive details.

## Decision

The cloud-account feature owns a strict, explicit renderer view. The list and account-returning mutations project full accounts into this view before IPC serialization. The projection copies only required display fields, UI quota fields, active flags and bounded health signals. Nested quota models omit gateway-only routing and forbidden-state fields. It maps raw status reasons to a small public category and replaces proxy and verification URLs with presence flags. The proxy editor accepts a new URL or a remove action through the existing account-scoped mutation without loading the stored URL into the renderer. Internal repositories and account services continue to use the full domain account. Electron remains the embedded owner of account operations in this slice.

## Alternatives considered

- Using `CloudAccountSchema` as the IPC output would keep exposing credential-bearing fields to the renderer.
- Omitting only `token` would leave proxy credentials and future account fields vulnerable to accidental exposure.
- Returning the stored proxy URL for editing would put its userinfo credentials back into the renderer. Replacement and removal provide the required controls without that read capability.

## Consequences

Renderer consumers use `CloudAccountView` and cannot rely on private account fields. Editing a configured proxy starts with an empty replacement input; users cannot reveal or copy the stored URL from the card. Explicit export and identity-profile operations retain their own separately reviewed contracts. This change does not route account operations to the standalone core.

## Verification

- Projection and ORPC tests assert the complete public view and reject token, device, raw status, verification and proxy fields.
- Proxy-editor tests cover replacement, removal without an accidental replacement save, and invalid input.
- Type checking, focused lint and boundary checks cover renderer consumers and contract wiring.

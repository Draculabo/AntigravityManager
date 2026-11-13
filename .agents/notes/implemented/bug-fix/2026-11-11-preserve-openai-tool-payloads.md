# Agent Note: Preserve OpenAI tool payloads

Status: implemented

## Problem

The OpenAI response adapters still used the name `apply_patch` as a custom-tool signal and
could rewrite its patch or substitute a diagnostic for its call. Responses history could
replace a failure if its first eight lines matched another result or after six distinct
failures. Matching prefixes can hide different file locations and errors.

## Decision

Bind outgoing tool representation to the client declaration and preserve the argument payload.
Only an explicit custom declaration uses the freeform input envelope. Keep recorded call IDs,
namespace mapping, built-in routing and admitted Responses tool output media. Remove the patch
preflight repair and failure compactor. Complete failure results pass through the established
message and request-size boundaries.

## Alternatives considered

- Adding an opt-in repair path would retain two ways to transform tool input and keep patch
  semantics in the gateway.
- Hashing complete error text could avoid false matches, but replacing a repeated result would
  still lose the association between that result and its call.

## Consequences

The client executes or rejects the supplied patch. Earlier callers that used the function-shaped
Chat custom response or automatic repairs can follow the
[upgrade guide](../../../../docs/upgrade-guides/next/openai-custom-tool-payloads.md).

## Verification

Mapper and HTTP coverage distinguishes ordinary and custom calls with the same name, checks
the complete patch input, and confirms separate failure results and media at the upstream
request boundary. No session storage migration is required.

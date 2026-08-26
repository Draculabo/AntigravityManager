# Agent Note: IDE token expiry and legacy device history normalization

Status: proposed

## Problem

IDE account imports currently discard a verified OAuth expiry timestamp available in the IDE Protobuf payload unless a refresh occurs. Imported tokens can therefore be treated as immediately refreshable despite having a known expiry. Legacy device-history entries without an explicit ID derive their ID from array position, and entries without `createdAt` use the current clock. Reordering a history array or reading it at a later time can consequently change durable normalized data.

## Proposal

The IDE importer will extract and preserve a valid absolute OAuth expiry timestamp from both legacy and unified Protobuf state. A successful refresh will remain the higher-authority source for the newly issued token lifetime. Legacy device-history IDs will derive from a canonical content fingerprint plus a duplicate occurrence counter instead of their absolute array index. Missing `createdAt` values will normalize to `0`, the explicit unknown-time sentinel, rather than the current time.

## Alternatives considered

- Continue assigning a one-hour synthetic expiry: rejected because it misrepresents the credential state and can defer needed refreshes.
- Treat all imported token expiries as unknown: rejected because the IDE state contains a verified value in supported payloads.
- Keep array index in the legacy device-history ID: rejected because ordering is not identity.
- Substitute the import time for missing `createdAt`: rejected because it makes repeated reads non-deterministic and invents a historical timestamp.

## Acceptance criteria

- Unified and legacy OAuth payloads expose their valid absolute expiry to the import adapter.
- A refresh response takes precedence over the prior IDE expiry for the refreshed token.
- Reordering distinct legacy device-history entries retains their generated IDs.
- A missing `createdAt` produces deterministic normalized output with `createdAt: 0`.
- Focused parser, importer, lifetime, and device-history tests pass.

## Risks

`0` must continue to be interpreted by presentation code as an unknown legacy timestamp where it is displayed. Identical legacy entries cannot be distinguished by content alone; the duplicate occurrence counter keeps their generated IDs unique but does not provide a stable identity if indistinguishable duplicates are independently removed or inserted. Protobuf fixtures validate the supported field layout, but they do not replace validation against all IDE versions in the field.

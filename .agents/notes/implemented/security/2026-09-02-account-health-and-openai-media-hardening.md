# Agent Note: Account health quarantine and OpenAI media hardening

Status: implemented

## Problem

Recoverable Google validation failures and revoked refresh grants previously remained transient proxy errors. A failed account could return to normal rotation, and the renderer had no narrow way to open a provider verification link. OpenAI-compatible structured output and inline audio also lacked complete runtime validation.

## Decision

The cloud-account feature owns an encrypted `health_json` column. Its closed schema records `VALIDATION_REQUIRED` with a ten-minute scheduler deadline and separately records the OAuth `invalid_grant` count and refresh block. Health is excluded from account exports. Invalid encrypted health fails closed by excluding that account from the loaded proxy pool. All health read-merge-write operations are serialized per account so concurrent validation and OAuth transitions cannot erase each other. The complete OAuth refresh state machine is also serialized per account: it reads authoritative persisted health, rejects a durable block before calling Google, performs the provider request, then persists and synchronizes the resulting health before releasing the account lock.

The retry layer uses the existing structured Google error classifier. A trusted validation failure persists health, records its deadline in the live lease token and clears that account's sticky sessions. Normal proxy selection excludes it only while `now < next_probe_at_ms`; it becomes eligible exactly at the deadline, including after restart. A successful monitor or manual provider probe can clear the persisted validation/UI state and reload a running lease cache. `SECURITY_POLICY_VIOLATED` remains non-persistent.

OAuth `invalid_grant` is retried once against the same client after an abortable 500 ms delay. The first independently confirmed failure persists count 1 and remains a transient error; a second persists count 2 and the refresh block, so process restart cannot reset the sequence. A successful refresh clears the OAuth failure state and synchronizes the active lease cache. Creating the durable block also evicts the account from a running lease cache, including when the transition originates in monitoring or IPC rather than lease hydration. Only a non-empty, distinct imported refresh grant may clear OAuth health and a locally generated OAuth-expired status; an unchanged export/import round trip retains the durable block. Validation health is preserved in either case. Only the typed refresh-rejection sentinel rotates the current request to another account.

The renderer can request `openAccountValidationLink(accountId)` only. The main process rereads the encrypted record and opens only HTTPS URLs on the exact `accounts.google.com` host.

OpenAI `json_schema` is cloned and cleaned before becoming Gemini `responseSchema`. Inline audio accepts strict base64 or an audio data URL, is capped at 15 MiB, is magic-byte sniffed where possible, and never fetches URLs or reads client-supplied filesystem paths.

## Alternatives considered

- Reusing `status` and `status_reason` was rejected because rate-limit display state cannot express independent sticky validation and OAuth eligibility safely.
- Permanently excluding a validation-blocked account until background monitoring succeeds was rejected because monitoring can be disabled; the ten-minute deadline must govern scheduler eligibility directly.
- Keeping the first `invalid_grant` only in memory was rejected because restart would defeat the two-operation confirmation threshold.
- Accepting arbitrary renderer-provided verification URLs or remote audio URLs was rejected because both cross a privileged network or shell boundary.

## Consequences

The accounts table gains one additive nullable column with no down migration. Health follows the same encryption and key migration path as tokens and quotas. Account exports remain portable and cannot transfer quarantine state. Proxy selection has a bounded second chance when token hydration fails, but never falls back to an explicitly excluded account.

## Verification

Focused tests cover JSON Schema mapping and malformed envelopes, audio validation and mapping, deadline-based validation quarantine, OAuth confirmation persistence and cancellation, running-cache eviction, typed-only lease rotation, serialized full-refresh operations, distinct-grant reimport recovery, unchanged-export reimport retention, the closed health schema and export stripping. They also prove that the OpenAI, Gemini and Anthropic paths keep the terminal upstream 403 when all candidate accounts are exhausted. Type checking, formatting, linting, agent-contract checks and the applicable unit suite are run for the final change.

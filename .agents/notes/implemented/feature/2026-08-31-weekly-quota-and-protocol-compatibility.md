# Agent Note: Weekly quota and upstream protocol compatibility

Status: implemented

Opt-in warmup and compatibility fixes are implemented locally; provider and native tray release validation remain external evidence.

## Problem

Unsigned Flash tool-call handling, platform tray assets, weekly quota presentation and weekly reset warmup needed to be aligned as one coherent feature. The previous implementation omitted request-envelope fields, admitted unsafe repeat scenarios, and removed non-weekly detailed quota presentation.

## Decision

Preserve the upstream signature conditions and real-signature precedence at the owning mappers. Share native Gemini envelope construction between user requests and internal warmup. Use the established Claude mapper for Claude warmup, including its token-budget behavior. On macOS use `tray.png` as a template image; elsewhere use `icon.png` without template rendering. Existing packaged assets remain unchanged.

Keep warmup scheduling and persisted policy in cloud-account, with a narrow type-only contract and an injected proxy-gateway executor. Requests remain in process and reuse the existing transport. Weekly presentation selects actual weekly buckets and preserves non-weekly details in the other view. Current behavior and recovery instructions are owned by [cloud features](../../../../docs/cloud_features.md) and [proxy compatibility](../../../../docs/proxy-compatibility.md).

## Alternatives considered

- Introducing a second desktop runtime would create incompatible process, HTTP and persistence boundaries in the existing Electron/NestJS architecture. The implementation therefore preserves observable request fields and mapper behavior within the established owners.
- Reset-minus-60-second eligibility risks early generation. This implementation waits for the reset timestamp. Its six-day reset-age guard and canonical history keys prevent stale cycles from becoming eligible after history cleanup; it does not use a six-day same-key retry allowance.
- One queue serializes all local entry points, honors enabled model groups, and reacts to configuration cancellation, avoiding overlapping background loops.
- Falling back to model-only quota or a fixed project ID would generate requests with unproven context. Missing provider groups or unresolved projects are skipped.
- Treating corrupt history as empty would make lost history look like permission to repeat. Strict reads pause execution instead. Request failure remains retryable, unlike success history.
- Adding a loopback `/internal` endpoint would broaden authentication and credential exposure. The injected executor requires neither.

## Consequences

These behaviors are implemented within the application's existing architecture and ownership boundaries. Visible group names are retained instead of forcing internal abbreviations. The final candidate has no trailing two-second wait. Native Gemini does not gain an additional session-cache mechanism. Renderer snapshots can lag a background update by one minute while visible.

The feature is disabled by default and states that quota/AI-credit consumption is real. HTTP acceptance, timer activation and exactly-once execution are distinct. Transport retry or a crash before persistence can duplicate provider-side work. No live credentials, external generation, database schema, auth policy or release configuration are changed by verification.

## Verification

Focused tests cover candidate dates and thresholds, forbidden accounts, canonical history, persistence errors, concurrency and cancellation, settings failures, both quota views, both signature aliases, public Gemini request paths, platform tray choices and loopback HTTP request bodies/fallback behavior. The implementation report records exact commands and results after the final verification run.

The unit test runner aliases native SQLite. A separate native persistence check bundles the actual settings store with an isolated database provider and runs two independent Electron-as-Node processes. It verifies native SQLite/Drizzle configuration and history round trips and corrupt-JSON rejection without opening the application or accessing user data.

Live-provider weekly reset effects, real credit consumption, packaged Electron execution, and macOS/Windows/Linux native tray appearance remain unverified here.

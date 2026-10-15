# Agent Note: Correlated operation diagnostics and Sentry reports

Status: implemented

## Problem

Google login and cloud-account switch failures lost their classifications before notification
details. Repeated logging could report reduced versions of the same failure to Sentry, while
GitHub reports had no operation reference that could establish which event belonged to them.

Read-only Sentry inspection on October 14, 2026 found candidate token-exchange transport and
HTTP 503 events for [Issue 349](https://github.com/Draculabo/AntigravityManager/issues/349),
credential-write failures for [Issue 351](https://github.com/Draculabo/AntigravityManager/issues/351)
and process-close failures for [Issue 344](https://github.com/Draculabo/AntigravityManager/issues/344).
Those historical records lack correlation IDs and cannot establish reporter attribution.
No sampled match for [Issue 347](https://github.com/Draculabo/AntigravityManager/issues/347)
establishes absence of that defect. The successful but incorrect account-isolation effects in
[Issue 337](https://github.com/Draculabo/AntigravityManager/issues/337) still require functional
acceptance; exception reporting cannot establish their correctness.

This decision improves diagnosability. It does not establish or repair the underlying causes
of those incidents or recover information removed from historical events.

## Decision

### Ownership and correlation

The trusted login/switch coordinator creates a UUID before dispatch. The renderer cannot choose
it. The selected core owner validates and echoes private request identities; desktop consumers
reject mismatched responses. Direct trusted owner calls create an identity when none is supplied.
The identity is independent of accounts, OAuth state, sessions and credentials.

Feature services own classification and valid login/switch field combinations. Shared
observability owns the closed wire vocabulary, bounded projection, invocation-local context and
SDK dispatch. Shared code imports no feature implementation. Root IPC composes the feature's
exported error parsers. The current contracts are documented in
[architecture](../../../../docs/architecture.md#correlated-account-operation-diagnostics) and
[security](../../../../docs/security.md#correlated-operation-reports).

Contexts finalize a terminal failure once, including an intentional non-reporting outcome.
Async log scopes end with their invocation; concurrent operations and late callbacks cannot
inherit another active operation. Forwarding a validated finalized diagnostic does not capture
it again. A rejected manual code submission has a separate attempt reference and leaves an
existing login running. Expected cancellation, denial, duplicate-account and admission outcomes
remain local diagnostics rather than unexpected Sentry events.

Management response version and owner compatibility advance together from `1` to `2`.
The handshake envelope and diagnostic schema remain `1`. An older owner fails verification
before account mutations; desktop never starts a local account owner as a fallback.

### Classification and persistence certainty

Recognized native codes, typed provider failures and observed HTTP status/code are promoted at
the failing step. Raw message substring matching does not classify the new diagnostic. Unknown
transport failures remain unknown or generic network failures. Existing provider retry and
refresh policy retain their behavior.

Login distinguishes a write not attempted, a confirmed write and an uncertain result. A later
finalization/view failure does not claim that enrollment failed before persistence. Lost remote
outcomes remain uncertain. UI guidance directs these users to check or refresh their account
list, without automatically replaying authorization or switching.

Switch failures preserve their public category, primary stage and native classification.
Credential readback retains Boolean comparisons only. The existing switch flow has no rollback
operation, so its diagnostic records `not-attempted`; diagnostics do not add rollback effects.

### Reporting and presentation

Both SDK adapters use temporary scopes and a sanitized exception with no original cause or
raw stack. Their operation-specific projection runs after SDK normalization. Serialization
inside the temporary context preserves structured diagnostics through the SDK's default depth;
the projection validates and reconstructs the bounded object before transport.

The owner tag is `operation_runtime`. A live check showed that Sentry derives the reserved
`runtime` tag from runtime context, so it cannot reliably identify the Manager owner.
Fingerprint inputs exclude diagnostic UUIDs and event IDs.

Public diagnostics are limited to 2 KiB; reports contain at most four classified causes,
twelve observations and four allowlisted repository source coordinates. Diagnostic contexts
have a 16 KiB budget. The local observation stream emits one overflow marker and then stops
adding observations; the terminal summary remains available. Automatic request/user data,
breadcrumbs, surrounding log prose, arbitrary extras and absolute paths are excluded from
operation events. Consent and configured DSN remain prerequisites.

`captured` means that the SDK returned an event ID, not that Sentry stored the event.
Disabled, unconfigured, unavailable, expected and dispatch-failed outcomes preserve the local
reference. Business failure handling never waits for SDK HTTP or flush. A private response loss
may still produce a separate coordinator transport event under the same operation reference;
local finalization does not promise exactly-once reporting across a partition.

Typed diagnostics survive owner status, private transport and public IPC. Toast details, copied
report text and CLI failures retain the reference and receipt semantics. Existing immutable
redacted toast snapshots remain the report source. Attachment sanitization admits only the
versioned closed diagnostic/step records and rejects unknown fields or continuations. Reporting
disabled does not remove local details or the explicit report action.

This extends the decisions for
[notification details](../feature/2026-10-10-error-notification-details.md),
[switch diagnostics](../bug-fix/2026-10-08-cloud-switch-sentry-diagnostics.md) and
[OAuth ownership](2026-09-24-headless-google-oauth.md).

## Alternatives considered

- Forward raw errors and provider responses: violates the public transport and reporting
  privacy policy, including through SDK cause/stack integrations.
- Improve toast formatting alone: cannot recover data discarded by the owner or IPC.
- Query Sentry from the renderer: exposes private read access and makes local error handling
  depend on remote availability.
- Use only an SDK event ID: loses the support reference when reporting is unavailable and
  incorrectly couples correlation to capture.
- Classify arbitrary English messages: cannot reliably distinguish wrapping, translation or
  provider changes. Only typed observations and closed codes are accepted.
- Migrate every error path immediately: broadens the change beyond the two established consumers.
- Add a persistent reporting queue: changes retention and still cannot prove remote delivery.
  Invocation-local finalization and explicit receipt semantics meet the current requirement.

## Consequences

- Desktop, CLI and core must upgrade together. Rollback reverts the coordinated diagnostic
  release and restarts through the normal owner lifecycle.
- There is no database migration, credential format/location change, retained account dataset,
  persistent queue or new OAuth/switch retry. Native credential mutation semantics remain owned
  by the existing writers.
- Historical Sentry issues are neither deleted nor resolved by this change. A new diagnostic
  reference permits support to inspect a future event without claiming historical attribution.
- The shared closed vocabulary is intentionally bounded. A future feature must define its
  valid combinations and provide boundary/privacy evidence before adopting it.
- SDK receipt and flush cannot prove storage. Remote receipt requires a separate read-only
  query; the private Sentry read token never enters the app, IPC or generated reports.

## Verification

Evidence was collected on Windows on October 14, 2026. Focused suites use synthetic enrollment
and isolated listeners/endpoints; native credential writes and real account persistence are
mocked or excluded before execution. Runtime harness paths resolve to isolated profiles.

| Evidence                                                                                                   | Observed result                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Login orchestration, public IPC, details/report text, clipboard, CLI and correlation: seven focused suites | 95 tests passed.                                                                                               |
| API timeout, refresh, callback/private transport and projection: four focused suites                       | 63 tests passed; overlaps the preceding selection.                                                             |
| Owner/RPC, enrollment and login compatibility: seven focused suites                                        | 69 tests passed; overlaps the preceding selections.                                                            |
| Final manual submission checks, including consumed local code and remote invalid request                   | 25 tests passed; rejection does not prevent the original login from completing.                                |
| Representative pre-change headless owner loaded in memory                                                  | Both new HTTP 400/503 preservation assertions fail because public IPC loses the diagnostic.                    |
| Actual Node/Electron SDKs with a bounded local receiver                                                    | One terminal event per runtime; injected private sentinels absent; disabled reporting retains a local receipt. |
| Actual SDKs against a receiver returning HTTP 503                                                          | Local capture remains available and does not assert successful delivery.                                       |
| Isolated Windows Electron ASAR diagnostic executable                                                       | Real SDK normalization, privacy projection and forwarding suppression pass.                                    |
| Controlled live events followed by read-only Sentry event queries                                          | UUID, stage/category, owner and release match both stored events; private sentinel absent.                     |
| Type checking, scoped ESLint/Prettier, runtime boundaries and diff whitespace                              | Passed.                                                                                                        |
| Standalone Core and CLI production builds                                                                  | Passed.                                                                                                        |

Stored acceptance references:

| Owner            | Diagnostic UUID                        | Sentry event ID                    |
| ---------------- | -------------------------------------- | ---------------------------------- |
| Standalone core  | `5dfcf2b1-0f6a-4cd6-a6b7-afe021feebd6` | `4174ba38923d445ebe5d66cde1ed059c` |
| Desktop embedded | `7793702d-ee95-4b6a-b226-fb3ab384ef52` | `2d1450ebb8fd4f4b8c4751782407d3fc` |

The isolated SDK executable contains no account/credential owner. Its ASAR result establishes
the packaged SDK path separately from the full product checks below. The functional ownership
chain also uses real callback and private endpoints plus controlled provider failures. Test
counts above overlap and are not an aggregate total.

### Full Windows product verification

The October 14 run uses the complete Windows x64 0.25.1 payload, Electron 37.10.3 and the
packaged standalone Node 24.19.0. Outputs remain in an isolated, ignored verification directory.

| Evidence                                                      | Observed result                                                                                                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full product, desktop-embedded and standalone-core owners     | Real login toast and Error details expose a UUID, stage, classified reason and unattempted account persistence. Public preload/IPC retains login and missing-account switch diagnostics.                              |
| Packaged CLI, real loopback callback and local HTTP 503 proxy | Terminal output and local log share the diagnostic UUID and retain `token-exchange`, `http-rejected`, status 503 and `temporarily_unavailable`. Synthetic private provider text is absent from the public diagnostic. |
| Credential/configuration recovery                             | Both application master-key slots remain unchanged; Windows login settings are restored; isolated profiles are removed. No official-client credential or real Google authorization is used.                           |
| Packaged native resources                                     | Real SQLite WAL/reopen, UUID-scoped OS credential CRUD/restart and the repaired Node presentation-composition gate pass as described below.                                                                           |
| Full Electron lifecycle                                       | Both owner modes, Settings navigation, shutdown, preference restart, external-core retention, desktop crash/restart and attached-core loss/restart pass.                                                              |
| Production WiX MSI                                            | Build and administrative extraction succeed. The versioned payload's EXE, ASAR, runtime manifest, Node, Core and CLI hashes match the tested package. This does not establish installation.                           |
| Production MSI installation gate                              | Refuses before installation because the host already contains a product in the same upgrade family. Existing product registration is preserved.                                                                       |

Two existing lifecycle harness assumptions required correction: the process-query native module
must resolve from packaged resources instead of being parsed by Rollup, and Settings readiness
must locate the current heading rather than require an `h2`. The separate injected IPC client
returns the actual ORPC error data for validation in the harness process; the production CSP and
product payload remain unchanged.

The initially failing standalone-native harness now uses the app-shell's Electron-free profile
connection. The throwing Electron substitute and presentation-side native-state guards remain.
Windows (including the final ordinary package payload) and WSL Ubuntu native suites pass
composition, verified closure, persisted reopen,
core crash recovery and stale-epoch rejection. Empty plaintext startup creates no master key;
explicit encryption persists a uniquely scoped key and a second process decrypts the synthetic
payload. See the [connection decision](../testing/2026-10-14-native-core-composition-boundary.md).

Packaging also exposed an initial Forge run that exited without a final artifact. A tracing
preload kept the packager alive until its existing hooks completed; it does not change the
product payload. WiX required a temporary short drive alias for long output paths. The verified
alias is removed after extraction. A subsequent ordinary `npm run package -- --platform=win32
--arch=x64` completes with a full artifact and no tracing or keep-alive preload; its actual
Electron lifecycle also passes. Two preceding runs fail correctly during Node download with a
timeout or TLS reset. The original premature successful exit is not reproduced and its cause
remains undetermined; the successful ordinary build does not establish that incident's cause.

Windows real-account A-B-A through the official Agy CLI passes three live Google identity
checks and three provider tasks for each Manager owner, CLI and Electron. IDE CLI and Electron
also pass all three steps with official authentication confirmation and live Google identity.
The first IDE Electron run preserves an upstream HTTP 502 failure: diagnostic
`2f883f29-ef63-4da7-b5c9-4d39eac61ad1`, stage `token-refresh`, reason `http-rejected`, target
`ide`, with rollback not attempted and reporting disabled. Its third switch fails before target
credential mutation; the complete retry passes. All these runs restore the original exact-target
Windows credential; CLI owners stop.

Classic initially verifies target token ownership and live Google identity but remains partial
behind official `Accept and continue` terms. The user manually completes first-run setup for
both test accounts. The harness must allow initial terms state to settle and open an account
panel whose Settings control appears after initial rendering. Both new regression fixtures fail
before those corrections and pass afterward; persistent terms still prevent readiness and are
never accepted automatically. With the complete prepared home, CLI A-B-A passes all three live
Google and visible official-account checks. Both the previous and current ordinary Electron
payloads confirm A twice but still display terms for B. Current-payload diagnostic acceptance
passes real toast/preload/IPC and packaged CLI checks; the application master-key slots remain
unchanged.

The installed official Classic 2.23.0 UI bundle (SHA-256
`867d1990b61d87f4b9ff8c5ecb1551c8688135267f32e56e02563f2d3e78fd68`) checks the last accepted
email and terms type, stored as `jetski.onboarding.lastLoginUsername` and
`jetski.onboarding.lastLoginIsGcpTos` in the profile's `app_storage.json`. It keeps one last-account
record. Its observed B dialog has reason `account_changed`, while the durable record matches A.
The UI first updates an in-memory cache, then batches changes after approximately 100 ms through
a serialized flush queue. A disappearing dialog alone does not confirm durable acceptance.
After another manual B acceptance, read-only comparison confirms both persisted fields match B;
the subsequent B-only initial launch and two ordinary restarts all confirm official identity
without terms. The exact-target credential is restored afterward. A separate restart probe
failed on a not-yet-created renderer page; its owned client was closed and credential recovery
passed. That harness failure is not an official login failure.

Controlled replay of the official main-process `StorageManager.updateItems` implementation with
synthetic concurrent writers loses a field on 19 of 20 runs and produces invalid JSON once;
sequential writes preserve both fields. This proves a non-serialized read-modify-write weakness
at that boundary, not attribution of the earlier live acceptance loss. The renderer batches its
two acceptance fields and serializes its own queue. No earlier acceptance-write trace was retained,
so the cause of that earlier incomplete update remains unknown. These checks do not modify or
patch the official client or fabricate a consent record.

The original refresh HTTP 502 occurred at 11:10:15 UTC on October 14. Its existing report retains
the failure phase and status but neither response headers/body classification nor intermediary
logs covering that request. The local 7897 listener is Mihomo; its retained application log does
not cover that request. A read-only synthetic observer around the current production refresh
client sees three real authorized refresh requests return HTTP 200 JSON, and one direct control
also returns HTTP 200. Returned tokens remain in memory and are not saved. These observations do
not identify who returned the historical 502. Google-origin failure and proxy-path failure remain
unresolved; a successful retry does not establish either cause or a repair.

An earlier Electron Classic attempt also records diagnostic
`6b6f13ab-5ee4-424b-8baf-7a95d2748f94`, native code `ANTIGRAVITY_PROCESS_FAILED`, during a
1,000 ms process probe before credential preparation. Its original stage is incorrectly
`target-write`. Launch preflight now maps to `client-selection`, and the switch-specific schema
admits that existing shared stage. Two new owner/IPC assertions fail before the correction;
four focused diagnostic/RPC suites then pass 50 tests, and TypeScript passes. The generic native
code does not justify inventing a more specific public failure reason. The failed live report
is preserved separately from the subsequent successful execution of that process operation.

Before those checks, native synthetic recovery verifies original credential content and writable
metadata, repeat recovery, unchanged-entry behavior and cleanup. Unsupported native attributes
refuse mutation. Secret bytes remain in memory and never enter the report.

## Follow-up: CONNECT proxy transport and durable Classic acceptance

A real refresh on October 15 reproduces HTTP 502 with an empty response via the configured
loopback proxy. The immediate direct control returns HTTP 200 JSON. Through the same proxy,
a CONNECT control also returns HTTP 200. The old Axios forwarding sends an absolute-form
HTTPS request to the HTTP proxy; it does not establish the TLS tunnel required on this path.
This identifies the current reproduction, not conclusive provenance of the October 14 incident.

Google requests now use the mature HTTPS CONNECT agent, with per-request destruction and the
same cancellation signal covering the proxy handshake. Explicit account and configuration
settings retain precedence; environment routing reuses the standard resolver and honors NO_PROXY.
The agent and resolver become declared production dependencies; their implementation is not
copied into this repository. No direct fallback or new business retry is introduced.

The exact production service is rebuilt and the same authorized refresh returns HTTP 200 JSON,
with CONNECT to the loopback proxy and TLS observed. A direct control remains HTTP 200. Tokens
stay in memory and are not saved. The proxy TCP controller is not listening, and configured
named pipes cannot be opened, so empty intermediary logs provide no additional attribution.

Rejected responses retain only closed route, literal destination class, transport and media
class observations from the Node request. Hostnames remain unknown. Addresses, URLs, headers
and body content never enter the diagnostic. These fields survive private management, public
IPC, error details, Sentry projection and structured-log sanitization within the public byte
budget. A proxy-path response alone does not establish which peer generated it.

A real loopback CONNECT fixture fails on the old code: the proxy receives a forwarded request
instead of a CONNECT. The corrected code passes proxy authentication, account/config/environment/
Electron proxy sources, and 502 HTML/503 JSON propagation. A stalled CONNECT control fails
without the handshake abort signal and passes with it. The synthetic peer resumes reading and
closes its writable half on EOF so its close event accurately reflects client cleanup.

Classic acceptance now verifies the configured isolated profile and waits for both durable
official acceptance fields to belong to the selected account. Its Electron regression fails
before this gate and passes after it. Read-only file checks cover missing fields, another account,
both terms types and malformed JSON. The reader never writes official storage or accepts terms.
The official single-last-account behavior remains unchanged; A-B-A terms prompts are still a
separate product limitation, and attribution of earlier same-account record loss remains open.

C-drive exhaustion interrupts initial test and approval initialization; those failures are not
negative regression controls. Verification uses an E-drive temporary directory and npm cache.
Real official-client restart/switch checks must wait for sufficient disk space to save state.

Clean-host MSI installation/upgrade/uninstall, physical macOS, system-wide Linux, real Google
authorization-code enrollment, Classic Electron A-B-A without repeated account-change terms,
historical 502 provenance, attribution of the earlier acceptance-record loss and the Linux
official-client matrix remain outstanding.
WSL native acceptance does not establish a system-wide Linux desktop. Administrative extraction
and executable acceptance cannot substitute for installer gates.

Reproduction commands and runtime gates are maintained in
[testing](../../../../docs/testing.md#account-operation-diagnostic-acceptance).
Run `npm run check:agent-contracts` when updating this note.

### Follow-up verification after disk recovery

After the user frees C-drive space, B completes one initial launch and two same-profile restarts.
Each check confirms the official identity and the selected account acceptance record both before
closing and after exit. The final report records ownerStopped, clientStopped and
originalCredentialRestored as true. An earlier attempt stops before renderer verification with
a token-refresh timeout; it is a network-stage failure, not evidence of a terms regression.

The final focused suite passes 97 tests across eight files; the acceptance harness unit suite
passes 67 tests. TypeScript, scoped ESLint, 24-file formatting and git diff checks pass.
The repository-wide format command reports existing style failures in unrelated directories;
those files are not rewritten. The synthetic Electron durable-acceptance check also passes.

Fresh Windows packaging first rejects a temporary directory under the source project. A retry
with a new external temporary directory reaches official Node download failures: TLS reset and
timeout. That owned external directory is removed after each attempt. A cache-assisted build
uses the existing official Node 24.19.0 executable only after checking its saved SHA-256; the
unmodified preparation script still obtains the current official checksum and verifies the bytes.
This does not establish that an uncached download succeeds from this host.

### Follow-up: complete structured log serialization

The rebuilt application exposed a further logging defect: the same HTTP evidence object was referenced by the terminal failure and its causes. The generic sanitizer treated repeated sibling references as cycles, replacing a cause HTTP object with a string and making the structured record invalid. A controlled packaged CLI CONNECT rejection reproduced the invalid cause path. Sanitization now tracks only the active ancestor path, preserving repeated sanitized values while still removing real cycles.

Generic token-key masking also removed safe credential-readback booleans. The logger now serializes only values accepted by the strict, bounded operation diagnostic schema directly; all other values retain generic sanitization. This preserves closed enum fields and readback booleans without accepting raw credentials, addresses, headers, or provider response text. Regression evidence includes actual Winston transport output, strict downstream log parsing, a shared-reference and real-cycle fixture, and 118 passing tests across nine focused suites. The new sanitizer fixture failed against the previous implementation.

### Follow-up: bounded packaged cold-start readiness

A fresh Windows package exposed a cold startup lasting 47.03 seconds from child creation to the core-started record. The existing 45-second service deadline had already made the desktop reject its selected owner. This is a separate startup failure, not loss of the HTTP diagnostic. The default readiness budget is now 90 seconds; success still requires the running management response and the desktop handshake/lease checks. No second child is launched while waiting. A deterministic 60-second healthy startup fails against the previous deadline and passes with the change; a never-ready child still fails at the bounded deadline. The existing owner-verification and shutdown suite also passes (26 tests across two suites). This change increases cold-start tolerance; it does not identify or optimize the OS/module-loading latency.

The packaged acceptance harness also bounds CDP connection and window discovery and performs desktop closure and core shutdown in independent cleanup blocks. Failure recovery uses exact executable/profile checks for the isolated desktop and, when its discovery files are already gone, the exact captured child PID, executable, entry and creation time for the test core. No formal application process or credential was changed by this empty-profile probe.

### Final Windows follow-up acceptance (2026-10-15)

The final x64 application package completed through the normal package command, including the Node checksum checks, runtime dependency/native preparation and runtime self-tests. As above, this build used the verified official Node cache and the temporary build-only public-download proxy; it is not evidence of successful uncached downloads. The temporary external build directory was removed after the package command returned zero. Final build hashes are retained in the local connect-final-build.json artifact.

The final packaged-operation gate passed all three runtimes (desktop-embedded, standalone-core and packaged CLI), including real notification details, preload/public IPC, controlled HTTPS CONNECT rejection, exact status/code/HTTP evidence, cause preservation and zero invalid structured diagnostic records. The measured desktop window readiness was 2,674 ms for embedded mode and 40,279 ms for standalone mode. Both application master-key slots were unchanged, Windows login settings were restored and the empty diagnostic profiles were removed. Evidence: out/correlated-diagnostics/installed-operations-97KojM/result.json. The earlier 47.03-second cold-start failure remains recorded rather than erased by the successful rerun.

The final real Electron Classic B control also passed: native token readback matched, Google identity returned HTTP 200, the official client identity was visible and confirmed, and the durable standard-terms record matched B. The control restored the exact original system credential and Windows login settings. Evidence: out/correlated-diagnostics/real-windows-bb7y7q/electron-connect-B.json. It covers one same-account B switch, not the full A-B-A matrix. The earlier same-profile initial launch plus two restarts also remained recorded and passed. No acceptance term was generated or written by the harness.

Focused regression evidence comprises 118 tests across nine diagnostic/proxy/logging suites and 26 tests across two service-launcher/owner suites; the final logging subset (41 tests) was rerun after its type adjustments. The 67 acceptance-harness unit checks, focused native UI integration, type checking, scoped lint/format checks and Agent contract validation passed. The formal MSI remains installed; no verification MSI or temporary installer alias remains. A formal IDE independently opened from uTools during the session was outside the acceptance profile and was left running.

Remaining gates: clean Windows MSI installation/upgrade/removal, native macOS and the current full platform/client switch matrix have not been established by this follow-up. The official last-accepted-account design can still prompt on A/B switches; same-account restarts only pass after the matching acceptance has actually persisted. Historical October 14 HTTP 502 responses cannot be attributed from the available logs alone. Cold-start latency itself was not optimized; the verified readiness budget is bounded at 90 seconds. No commit or push was performed.

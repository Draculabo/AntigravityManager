# Diagnostic Privacy Contracts

This reference owns reporting consent, sanitized diagnostic projections and receipt limits across runtimes. Global requirements remain in [Security](../security.md).

## Schema diagnostics and Node reporting

Schema diagnostic logs contain fixed issue categories, protocol, recovery flags, ordinal tool
positions and bounded counters. Schema/ref strings, tool names, prompts, credentials and account
identifiers do not enter those records. Isolated Sentry events replace inherited user data with
`{ geo: {} }` and remove request,
breadcrumbs, contexts, exception and extra fields; the logger supplies no surrounding logs.
Reporter exceptions cannot fail gateway execution or recursively report themselves.

Sentry Relay can derive geography from the connection IP even when `sendDefaultPii` is disabled
and the event contains no IP. The empty geo object prevents that enrichment without sending
identity, IP or location values. Check outbound envelopes and remote stored events separately;
the strict remote privacy check still rejects any nonempty user data. The acceptance relay
forwards the envelope to the configured Sentry project and retains only field-presence and
empty-override booleans. It does not change project settings or export event bodies. See the
[decision and remote evidence](../../.agents/notes/implemented/security/2026-10-08-isolated-sentry-geo.md).

Standalone core uses the explicit `@sentry/node` dependency, with automatic integrations disabled.
General logger exceptions are copied with a redacted message/stack and without arbitrary provider
error properties. `SENTRY_DSN` and `SENTRY_RELEASE` are runtime inputs. A desktop launch passes its
exact preference location through `ANTIGRAVITY_DESKTOP_PREFERENCES_PATH`; a CLI launch without
that location starts reporting disabled. The selected desktop owner receives preference changes
through a Boolean-only private configuration route. Enabling after disabled startup installs
the reporter; disabling prevents subsequent submissions. No second durable consent switch is
introduced. The Node flush has a 2-second deadline and cannot retain profile ownership.

The replay command reads the audit database without migrations or repairs. Private request data
stays in memory, while output contains aggregate counters. Audit sanitization may change a Schema
named `password` or `access_token`; modified data cannot establish an original production defect.

## Correlated operation reports

Google-login, cloud-switch and local-snapshot-switch public diagnostics are strict closed variants limited to 2 KiB
of UTF-8 JSON. They contain a random operation UUID, stage/category, observed allowlisted native
or upstream codes, optional HTTP status and an SDK reporting receipt. Rejected Google HTTP
responses can also retain the native Node route (HTTPS CONNECT/forward proxy/origin/unknown), literal destination
class (loopback/non-loopback/unknown), TLS/plain/unknown transport and response media class.
The CONNECT destination describes the proxy host; a hostname has unknown destination class; no DNS or response origin is inferred. These closed
observations do not prove which intermediary generated a response. Addresses, proxy URLs,
headers and response bodies are excluded. Login tracks persistence
as not attempted, confirmed or uncertain. Switch readback retains Boolean matches, never stored
or expected credentials. At most four classified causes survive; raw causes stay in the owner.
The UUID is a support reference, not a capability or account identifier.

Process failures also retain a closed process reason and, when observed from Win32, an unsigned
32-bit Windows error code. A failed normal-close request preserves that evidence through its
outer failure; no-window, enumeration, posting, native-call and exit-timeout outcomes remain
distinct. Raw causes stay in the owner. Paths, process IDs, command lines and native error prose
are excluded from this projection. The public category can remain `process-close-failed` while
the process observation and cause list identify an access-denied native result.

The logger serializes fully validated terminal diagnostics and switch traces without generic token-key masking,
so safe readback booleans and repeated cause evidence retain their exact types. Other log arguments
still use generic sanitization, which masks secrets and replaces actual ancestor cycles while
preserving repeated sanitized sibling values.

Operation SDK capture requires the existing reporting consent and DSN. `captured` means only
that capture returned an event ID; it does not establish delivery or storage. Disabled,
unconfigured, unavailable and expected outcomes retain local references. Dispatch throws do
not fail or retry business execution. Cancellation, authorization denial and duplicate-account
outcomes are not unexpected-error events. Ordinary forwarding of a finalized diagnostic does
not capture it again. A lost private response can still produce a distinct coordinator-side
transport report for an uncertain remote outcome.

Each capture uses a temporary SDK scope and a synthetic classified exception. The operation
projection replaces the normalized event with allowlisted content: up to twelve safe login
observations or sixty-four switch observations, at most four allowlisted repository source coordinates,
closed OS/runtime metadata, release/environment and non-identifying trace IDs. Classic attempts can
also retain a strict switch trace with at most thirty-two events and 48 KiB of UTF-8 JSON. It includes
logical function owners, ordered stages, elapsed times, continuation, observed effects, up to eight
closed causes and eight allowlisted source coordinates per failure. Supplemental truncation is
explicit; original exception prose and absolute caller paths are never retained in the trace.
Diagnostic contexts remain below 64 KiB; overflow drops supplemental context and observations while
preserving the primary failure and switch trace. User data, request data,
surrounding log prose, automatic breadcrumbs, arbitrary extras and absolute paths are excluded.
The empty geo override prevents IP-derived user geography. Safe repository coordinates are
optional when the runtime stack lacks a recognized source suffix; no synthetic caller stack is
sent to public IPC. The owner tag is `operation_runtime`, since Sentry can derive and replace
the reserved `runtime` tag from runtime context. UUIDs/event IDs do not enter fingerprints.

The SDK capture does not wait for HTTP or flush. Event receipt is established separately by
a read-only Sentry query; no Sentry read token is shipped or exposed through IPC. Existing
account storage, native credential effects, retries and owner lifecycle remain authoritative.
Diagnostics add no durable queue, account scan, automatic OAuth replay or switch retry.

Classic hot-attempt recovery has one operation identity and one final report. Successful recovery
returns switch success and produces a consent-controlled warning tagged `recovered-by-restart`;
terminal failure retains both attempts as one error. The compact public recovery summary identifies
the initiating hot stage and any failed restart stage. Local owner/RPC/IPC forwarding preserves the
finalized diagnostic instead of capturing it again. Logging or reporting failure cannot change a
confirmed successful result. See [the runtime contract](../modules/antigravity-runtime/classic-switch.md).

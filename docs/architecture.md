# Architecture

This document is the current architectural map for Antigravity Manager. Read it before changing process boundaries, IPC, persistence, routing, or the proxy gateway. Decision rationale belongs in [Agent Notes](../.agents/notes/README.md), not here.

## Error report attachments

The app-shell module owns optional diagnostic log attachments. Electron main reads its `app`
logs; standalone mode also reads a sanitized `core` snapshot through the selected owner's
private RPC. The renderer receives only the preview and a temporary save capability. The main
process holds that exact snapshot and owns the save dialog and atomic export. No log upload
service or general filesystem API is exposed. See [the privacy and export policy](security.md#sensitive-data).

## Gateway Schema admission

OpenAI Chat, effective Responses requests and Anthropic Messages prepare tool parameter schemas
before account selection and retry. Prepared request copies are reused by account and project
fallbacks. Structured-output schemas reject conversion failures; eligible tool child nodes use
a fixed string fallback while retaining the tool, sibling parameters and required relationship.
Native Gemini dialect conversion remains separate. Responses WebSocket validates effective
configuration before publishing prewarm events or replacing socket request state, and reuses
its prepared schemas during generation. See the [Schema reference](proxy-schema-conversion.md)
for supported references, bounds and error contracts.

Error reporting uses runtime-specific Electron and Node SDK adapters. The logger submits one
isolated bounded Schema summary per preparation, subject to consent and an available DSN.
Desktop preference effects are serialized and forwarded to the selected core through a typed
private configuration operation. Core initialization follows profile ownership acquisition;
shutdown bounds reporting flush independently from ownership release. Reporting does not own
account selection, quota policy or persisted Responses formats.

## Thought signature ownership

OpenAI Chat and Anthropic Messages derive an in-memory signature scope from the proxy
credential digest, a client session hint and a conversation content anchor. Session hints
come from session/conversation headers, query parameters, then body metadata. The anchor
contains the initial user content, system instructions and declared tool names, so a shared
user ID or reused session ID cannot replace conversation ownership. Appended turns retain
the anchor; changed initial context produces a cache miss. Identical context and hints under
the same credential produce the same scope; clients that need independent identical
conversations must supply distinct session IDs.

Empty user preambles are ignored. Without meaningful user content, the complete available
history becomes the anchor; an empty history receives a fresh scope and cannot recover a
signature from another request.

Account affinity uses the session hint when available and the content anchor otherwise.
Signature ownership always includes the content anchor. Cache keys contain digests, never
credentials or conversation text. The signature store refuses unscoped reads and writes.
Unsigned historical tool calls recover only a matching scoped tool-call ID and tool name,
subject to effective model compatibility. They do not borrow the latest signature from a
session or from another request. Explicit signatures carried by the request remain intact.
Responses continues to use its committed response/parent IDs for signature lineage.

See the [ownership decision](../.agents/notes/implemented/bug-fix/2026-10-09-signature-session-isolation.md)
for failure behavior and the limits of content-derived identity.

## Settings interfaces

The renderer reads and updates proxy/runtime settings through config.service, account notification
thresholds through config.accountAlertPolicy, and window/UI preferences through config.desktop.
The corresponding query cache keys are serviceConfig, ccountAlertPolicy and desktopPreferences.
The private standalone RPC uses serviceConfig and ccountAlertPolicy; the selected configuration
adapter delegates to the desktop service or the standalone core. The service schemas and operations
live in src/modules/config/service-config.\*. These interface names do not change the existing
configuration file locations or stored account alert settings.

Upstream proxy settings require a saved HTTP(S) URL before enabling. Clearing the URL disables
the proxy in the same serialized configuration write. Secret-presence metadata reports whether
the address is valid without exposing it. Legacy invalid enabled configurations remain editable;
unrelated settings writes do not silently change their routing. Google login checks the proxy
before returning an authorization URL and reports a fixed configuration failure through both
desktop-embedded and standalone-core adapters. Configuration changes during authorization are
checked again before token exchange. Invalid configurations never fall back to direct requests.

## Renderer state

TanStack Query owns remote account data, configuration and mutation results. The account page
uses a [page-scoped Zustand store](../src/modules/cloud-account/stores/AccountSelectionProvider.tsx)
for batch selection. Cards subscribe to their own selected flag; select-all and batch controls
subscribe to derived values. Bulk operations read the current selection when invoked and
exclude accounts hidden by the current filter. Selection is not persisted and starts empty
when the page remounts.

Login and file dialogs own their input, open state and mutations. Authorization-code input
stays local to the login dialog and does not enter the selection store. Quota display
preferences retain their existing local-storage codecs. The renderer Vite configuration
enables React Compiler to memoize eligible components and calculations; subscriptions still
determine which state changes trigger rendering.

Account cards select only their own model-availability entries from the shared gateway query.
Traffic Monitor keeps its statistics query, search draft and live-update counter in separate
components. Statistics polling and queued notifications do not update the request table.
The existing list polling, detail refresh, category filtering and manual refresh policy remain
in effect; these UI states are not copied into a global store.

## Runtime topology

```plaintext
Renderer (React, TanStack Router and Query)
    |
    | window.electron + typed ORPC client
    v
Preload (contextBridge and MessagePort transport)
    |
    v
Electron Main
    |-- ORPC router composition
    |     `-- feature-owned routers and handlers
    |-- application lifecycle, windows, tray and updates
    |-- SQLite and OS credential stores
    `-- desktop-embedded NestJS + Fastify gateway
          `-- OpenAI, Anthropic and Gemini-facing adapters
```

The Electron main process is the trusted application host. The renderer is treated as an untrusted UI process and receives only the APIs exposed by [src/preload.ts](../src/preload.ts). The preload creates the MessagePort transport used by the renderer-side ORPC client in [src/ipc/manager.ts](../src/ipc/manager.ts). Main-process RPC handling is installed by [src/ipc/handler.ts](../src/ipc/handler.ts).

An explicitly launched standalone Node core is also available through `npm run build:core` and `npm run start:core`. [src/core/main.ts](../src/core/main.ts) initializes the existing account persistence and local database, then starts the existing NestJS gateway when the saved proxy configuration enables auto start. It exposes status and shutdown through a Fastify HTTP server bound only to a Unix socket in a private runtime directory or a Windows named pipe. Before either runtime loads profile configuration or opens account/database storage, it claims the same process-lifetime profile ownership endpoint. An existing owner makes the other runtime fail closed with the owner kind and PID. Stale Unix socket recovery uses an exclusive guard so competing starters cannot both claim the endpoint. Desktop-embedded ownership remains the default. The desktop can instead attach to a verified standalone core through the startup composition described below.

The same private endpoint hosts a separate [core application RPC router](../src/core/rpc/router.ts) under `/rpc`. Its oRPC client uses the existing local pipe/socket and offers ping, gateway status, context-cache counters, gateway start/stop, credential-free cloud-account summaries, strict cloud-account views, manual quota refresh, proxy replacement/removal and account deletion. Application calls are accepted only while the core is running; shutdown closes admission, cancels and drains warmups, and drains the management server before stopping persistence or releasing profile ownership. Long-running account mutations have a separate bounded client and server timeout because they can call several upstream endpoints. Electron's existing MessagePort router delegates gateway status, context-cache reads, start and stop to an explicitly selected [gateway adapter](../src/modules/proxy-gateway/ipc/gateway-adapter.ts). Default desktop startup selects the desktop-embedded implementation; the standalone-core implementation calls the core RPC client and propagates transport failures without falling back to desktop-embedded state. Both runtimes use the same [gateway lifecycle service](../src/modules/proxy-gateway/services/gateway-lifecycle.service.ts) to serialize start and stop. Core management status follows completed standalone-core lifecycle mutations. The cloud-account list, manual quota refresh, IDE sync, proxy writes, deletion and OAuth-client preference follow the same pattern through a feature-owned [account adapter](../src/modules/cloud-account/ipc/cloud-account-adapter.ts). Its desktop-embedded and core RPC list paths share the [list service](../src/modules/cloud-account/services/cloud-account-list.service.ts), including active-target resolution and the legacy OAuth-client-key backfill. Default Electron startup selects the desktop-embedded account adapter; standalone-core failures do not fall back to local persistence. Legacy local-account operations also follow the selected owner described below; desktop ownership composition follows the startup mode. Configuration key generation uses the selected service adapter. The cloud-account list and account-returning mutations project an explicit [renderer view](../src/modules/cloud-account/services/cloud-account-view.ts) before crossing MessagePort; internal account services retain the full account model.

The Node CLI in [src/cli](../src/cli) builds independently and offers `service status`, `service start`, `service stop`, and `account login`. It uses Commander for command parsing and a typed, version-checked client over the local management endpoint. `service start` checks profile ownership before launching a detached child, rejects a desktop owner and waits for an already starting core to become ready; `service stop` waits for endpoint disappearance after the shutdown acknowledgment. `account login` starts the core if needed, uses the core's active/default OAuth client, prints a Google authorization URL for a browser on the same machine, and polls for a safe account summary. The Node core owns a temporary loopback callback listener and performs the token exchange and local SQLite account enrollment internally. Neither command sends account credentials or API keys through the management protocol or child arguments.

CLI-only command parsing, output and detached process launch belong in `src/cli`. `src/core` owns the standalone service and its local transports because Electron standalone-core adapters and the CLI both use those contracts. The local RPC HTTP client uses Axios over the private socket or named pipe; the profile lease retains a raw `node:net` protocol to claim ownership before either runtime starts HTTP services.

Cloud-account quota refresh lives in the [feature service](../src/modules/cloud-account/services/cloud-account-quota-refresh.service.ts), which can run under Node without importing Electron IPC. It preserves token refresh, quota and credit retrieval, cached rate-limit fallback, account status, validation health and capability failure updates. The desktop composition updates the tray on primary success and schedules [Node-safe weekly warmup](../src/modules/cloud-account/services/cloud-account-weekly-warmup-runner.ts) on either success path. Core RPC uses the same quota service and schedules warmup without desktop effects. The post-import task calls the quota service and schedules warmup without updating the tray. The monitor retains polling and notification policy while delegating warmup execution and post-warmup quota writes to that runner. The standalone core configures the warmup executor without starting the desktop monitor. Shutdown closes account-mutation admission and drains admitted refreshes, IDE sync operations and warmups before stopping persistence and the gateway. Desktop-embedded remains the default account ownership mode.

IDE account sync runs through the [feature-owned import service](../src/modules/cloud-account/services/ide-account-sync.service.ts) in the process that owns account persistence. The account adapter and core RPC return only a strict cloud-account view or null. The renderer receives stable sync failure categories instead of provider messages, local database paths or stacks. Standalone shutdown drains admitted sync operations before releasing profile ownership. The underlying IDE token extraction and account merge policy remain in the existing import adapter.

Cloud-account switching runs in the [Node-safe feature service](../src/modules/cloud-account/services/cloud-account-switch.service.ts) under either account owner. The service keeps the existing switch guard, token refresh, enterprise project resolution, target-specific credential injection, identity profile, process lifecycle, active-account persistence and switch metrics. The desktop wrapper adds only the tray update. The renderer's account adapter selects desktop-embedded execution or the private core RPC; both validate the account ID and target and return stable error categories. Core shutdown stops admitting new account mutations and drains admitted switches before persistence teardown. Desktop shutdown also closes switch admission and waits for admitted switches within its existing three-second forced-exit window. Desktop-embedded remains the default ownership mode.

Cloud-account identity-profile reads and mutations run through the [account-owned profile service](../src/modules/cloud-account/services/cloud-account-identity-profile.service.ts). The account adapter selects desktop-embedded execution or private core RPC with the same capture, generation, binding, history and baseline policy. Renderer and core RPC use strict, bounded profile transport schemas while the existing persistence codecs continue to normalize legacy stored profiles. Core shutdown drains admitted profile mutations before account persistence stops. Opening the identity storage folder remains a desktop-only shell action.

Cloud-account backup and restore use the [owner-side file service](../src/modules/cloud-account/services/cloud-account-file.service.ts). Electron main opens system file dialogs and captures the selected account adapter before selection. The desktop-embedded owner reads or atomically writes the file; the standalone-core adapter sends only a bounded path and operation options over private RPC. React receives saved/cancelled status or a bounded import summary, never file contents or paths. Import reads at most 5 MiB plus one detection byte and preserves the existing merge, overwrite and skip-existing rules. The owner schedules quota hydration, warmup and account-cache reload for successfully imported accounts. Standalone-core imports join account-mutation admission and drain. Electron still selects desktop-embedded ownership.

Auto-switch settings, model policy, force polling and weekly-warmup configuration follow the selected account adapter. The [Node-safe monitor](../src/modules/cloud-account/services/CloudMonitorService.ts) preserves token/quota/status polling, target selection, five-minute scheduling, focus debounce and one active poll. The standalone core starts recurring maintenance only when auto-switch or weekly warmup is enabled. Auto-switch calls the owner-side switch policy directly. Electron configures [desktop effects](../src/modules/cloud-account/ipc/cloud-monitor-desktop-effects.ts) for quota/credit/switch notifications and tray updates; the core has no OS notification delivery. Window focus starts local polling only for desktop-embedded ownership, while explicit refresh delegates to the selected owner. Disabling both background features stops the scheduler. Shutdown closes monitor admission and drains admitted polling and warmups before releasing persistence and ownership. Settings writes and force poll use the long account-work RPC contract and stable errors. The Electron owner selector remains desktop-embedded.

The account adapter also reads security status from the selected account owner. Validation-link lookup runs in that owner's [account service](../src/modules/cloud-account/services/account-validation-link.service.ts), which accepts only a bounded trusted Google HTTPS URL. In standalone-core mode the URL crosses the private core RPC to Electron main, where it is validated again before opening the system browser. The renderer action returns no URL and reports only stable failure categories. These short operations do not join the long-running account-mutation drain set.

Desktop Google login uses the same [owner-side OAuth session service](../src/modules/cloud-account/services/headless-oauth-session.service.ts) as the standalone core. The renderer route selects the account adapter. Its [desktop-embedded composition](../src/modules/cloud-account/ipc/desktop-oauth-login.ts) enrolls in Electron main; its [standalone-core composition](../src/modules/cloud-account/ipc/standalone-core-oauth-login.ts) starts and polls a core-owned session over the private management endpoint, opens only a validated authorization URL in Electron main, and reads the strict account view from core RPC. An optional OAuth client key is captured atomically when the core session starts. Browser callback completion adds the account automatically. The desktop also keeps the manual authorization-code field: while a login is pending, a pasted code goes through a bounded renderer request to the selected owner, which exchanges it with the same client and redirect URI. Callback and manual submission compete for one session; only the first can enroll. The renderer receives only a strict account view or stable failure category; tokens, callback state, session IDs and authorization URLs stay outside React. The desktop no longer starts a separate fixed-port callback server or delivers callback codes through preload. Desktop shutdown cancels its pending session; the core finishes any enrollment already admitted. Desktop-embedded shutdown drains accepted enrollment before gateway teardown within its bounded exit window. Electron still selects desktop-embedded account ownership at startup.

Standalone account owners publish quota, credit and successful switch hints in a bounded [in-memory journal](../src/modules/cloud-account/services/account-owner-events.service.ts). The private read-only RPC returns an epoch, monotonic cursor and at most 32 events from a 128-entry journal. Standalone-core Electron composition starts a sequential presentation pump after tray initialization and resolves display data through strict owner account views. Epoch changes reset the cursor; duplicate events and presentation failures never replay account mutations. Overflow drops the oldest presentation hints. Desktop-embedded composition presents effects directly and does not consume the journal. Tray switch and refresh actions delegate to the selected account adapter. Shutdown stops and drains the presentation pump.

Local-account discovery, validation, confirmation, discard and post-import status use the selected account adapter. The [coordinator](../src/modules/cloud-account/local-import/local-account-import-coordinator.service.ts) retains credential material in short-lived owner memory and returns only strict bounded summaries and an opaque UUID. Electron binds each capability to its creating adapter instance; reselection rejects old capabilities. A restarted core has no matching session. Confirmation consumes the capability before persistence and joins account-mutation drain. Shutdown clears reusable sessions, waits for admitted preview/confirmation work and then drains owner-side hydration/cache tasks. An in-flight preview cannot create a capability after admission closes or reopens. Discovery and deduplication policies remain unchanged; oversized transport summaries fail closed.

Switch diagnostics follow the selected account adapter and use a strict read-only core RPC. Metrics, switch guards and device-hardening safe-mode state belong to the process performing switches, as indicated by an explicit provenance and volatile process epoch. Restart creates a new epoch without merging counters from Electron. Failed-switch messages are fixed public text; reasons and hardening stages are closed enums. Guard summaries expose at most 128 queued owners while retaining the total pending count. Diagnostic reads do not join account-mutation drain or modify hardening state. An unavailable standalone-core owner produces a stable error instead of desktop-embedded counters.

Configuration uses separate ownership contracts. The selected configuration adapter reads and serializes runtime/proxy changes in the owner, preserves the existing `gui_config.json` durable format, and applies gateway changes only in that process. Persisted changes return `applied` or `restart-required`; application failure does not roll back a successful durable write. Admitted configuration work drains during shutdown. Executable paths and arguments are owner settings; binary patch preparation reads the current owner snapshot.

Electron stores desktop preferences in versioned `desktop-preferences.json` under its user-data directory. Its first read seeds only desktop fields from the legacy GUI file; subsequent reads never reseed. Desktop writes have no shared-profile effects and remain available when the standalone-core owner is unavailable. The settings view combines these independent sources for display and sends only changed fields to their owning contract. Alert policy retains its effective SQLite settings source through a separate selected-owner API; stale same-named GUI fields are not promoted into monitoring policy. Startup consent reads use the desktop file when present, with a read-only legacy fallback before its creation.

Ordinary owner configuration snapshots exclude API keys and upstream proxy URLs. Dedicated reveal, replace/remove and key-generation operations support explicit user actions. Generation returns safe presence metadata; reveal values stay outside query caches. Standalone-core errors never fall back to desktop-embedded configuration.

Local Antigravity IDE account snapshots, switching/restoration, deletion and identity operations use the selected local-account adapter and the same Node services in both owners. Credential-bearing backups and their paths stay in owner storage; normal list/snapshot responses are strict bounded metadata views. The unused raw backup/restore IPC actions are removed. Existing same-email replacement, identity history, switch guard and target-specific SQLite versus credential-store behavior are preserved. All accepted local-account operations are tracked, mutations are serialized, and shutdown closes admission and drains reads/restores/identity writes before teardown. Opening the identity storage folder remains an Electron shell action. Standalone-core failure never executes desktop-embedded persistence.

OpenCode status, synchronization, configuration preview, restore, clear and dedicated-key revocation run through the [selected integration owner](../src/modules/proxy-gateway/opencode-sync/opencode-owner.service.ts). The same Node service retains external plugin v3 account selection and configuration backup/recovery policy in both runtimes. Reads and writes share a serialized queue, including awaited installation detection, and are admitted and drained before profile teardown. Default Electron startup selects desktop-embedded ownership; the standalone-core adapter propagates failures without local file or credential fallback. The renderer receives bounded location metadata and a redacted configuration preview, never account refresh grants or dedicated keys.

Audit body file export uses the [selected file owner](../src/modules/proxy-gateway/audit/audit-file-owner.service.ts). Electron captures the current adapter before showing the save dialog, then passes only the selected absolute destination and body ID to that owner. The owner streams existing audit pages into a restrictive sibling temporary file, synchronizes it and atomically replaces the destination. Renderer responses contain saved/cancelled status only. Exports above the ordinary RPC response limit never transfer body content through control RPC. Admission and drain keep accepted exports ahead of persistence teardown.

Audit list/filter/detail, body paging/search, statistics and delete/clear/repair use the [selected audit owner](../src/modules/proxy-gateway/audit/audit-owner.service.ts). Its ordinary responses reserve envelope space below the existing 1 MiB transport ceiling. JSON-expanded body pages defer whole chunks to the next cursor rather than dropping content. Request UUIDs and existing `admin:<integer>` record IDs remain supported. Up to 128 admitted operations share a serial queue and drain before persistence teardown. A bounded owner journal delivers reference events through epoch/cursor polling; overflow or owner restart causes a renderer refresh, window closure stops polling and selection changes discard stale replies.

The [IPC recorder](../src/modules/proxy-gateway/audit/ipc-audit-recorder.ts) supports explicit desktop-embedded or standalone-core selection. Desktop startup still selects desktop-embedded ownership. Standalone-core capture opens an owner-local parent and asynchronous request context through an epoch/UUID capability, preserving route exclusions and session aliases. The private transport carries that capability on business calls to the same endpoint; the core restores its parent, shared attempt sequence and Thought session without accepting caller-supplied parent IDs. Endpoint changes and stale capabilities fail closed. Up to 128 captures expire after five idle minutes; active owner calls postpone expiry. Core shutdown drains active calls and marks abandoned payloads incomplete before persistence teardown. Desktop quit drains admitted IPC handlers under its existing forced-exit bound.

Input/output capture reuses the existing incremental redactor in main and sends sequential UTF-8-safe 64 KiB base64 chunks. Only `/rpc/ipcCapture/append` and `/rpc/ipcCapture/appendMetadata` permit a 96 KiB request envelope; ordinary control calls retain 4 KiB. The owner acknowledges SQLite writes, enforces the existing 100 MiB stored-body ceiling, validates sequence/encoding/accounting and verifies complete nonoversized hashes. Logical size and full hashes for oversized bodies come from the trusted main serializer. Persistence queue rejection produces an incomplete body while retaining the business result.

Capture metadata preserves the existing direct/nested model extraction and sanitized error snapshot, including its stack. Values that exceed the small control envelope use the metadata chunk lane. A preparing capability cannot execute business calls until its input metadata is complete; input fields become immutable afterward. Each metadata field has a 100 MiB byte ceiling and the owner retains at most 256 MiB across capabilities, releasing reservations on completion, expiry or drain. Stored session IDs retain their original value; the existing Thought session-key normalization remains separate. Production forced-exit timing and whole-application selection remain cutover gates.

Thought session/record summaries, statistics and delete/clear/repair use the [selected Thought Store owner](../src/modules/proxy-gateway/thought-store/thought-owner.service.ts), including metadata-only maintenance audit events. Explicit single-record detail and cURL export use owner-local content capabilities. Each capability binds its epoch, UUID, purpose and resource, expires after five minutes and supports sequential 64 KiB base64 chunks. Each content owner retains at most four capabilities and 256 MiB of body buffers. Thought text retains its 64 MiB ceiling; visible text and nullable signatures are separately sized and reconstructed in Electron main. The combined record body has the explicit 256 MiB transfer budget. Ordinary summaries and metadata stay below the normal response cap. The unused all-records `thoughtSession` IPC route is removed; the existing HTTP/server session API remains.

cURL construction retains its 8 MiB replay-body limit, explicit current-key opt-in and upstream-credential prohibition. Final shell quoting can expand the command, so its capability permits up to 64 MiB. Electron main captures the selected owner across opening, reading and cleanup, then immediately writes the command to the clipboard. Renderer responses expose copied status only. Consumed/closed/expired capabilities release buffers; owner drain clears remaining snapshots. These capabilities do not establish whole-application standalone-core ownership.

The core build emits `traffic-audit.worker.js` and `thought-store.worker.js` alongside `main.cjs`, matching the Node services' worker paths. Their SQLite binary must match the standalone Node runtime; the desktop's Electron native binary is a separate runtime artifact. See [worker verification](testing.md#focused-commands) for the limited native smoke coverage.

Each `BoundedSqliteWorker` instance closes terminally: new reads/writes and lazy startup are rejected as soon as closing starts. Concurrent closes share one result. Accepted commands and the shutdown acknowledgement share the two-second default deadline; termination is awaited even after timeout. Timeout, acknowledgement and termination failures remain observable through the rejected close result.

Audit and Thought Store services distinguish reusable `close()` from terminal `shutdown()`. Process shutdown rejects new reads, capture, repair and configuration work, stops maintenance and gives accepted body/SSE writes, hydration and repair up to two seconds to drain. Accepted repair may finish replacing its worker during drain; once drain finishes or times out, worker access and recreation are sealed. Both stores are attempted even when the gateway was never started or is already stopped, and failed closure propagates. Core shutdown drains standalone-core IPC capabilities before terminal diagnostics and retains the profile lease on failure. Desktop exit uses the same store teardown under its existing three-second forced-exit bound, which can interrupt cleanup.

The [ownership cutover audit](ownership-cutover-audit.md) records migrated owner boundaries and remaining release gates. Desktop bootstrap selects all migrated feature owners together; native delivery and platform acceptance determine release readiness.

### Desktop owner bootstrap

The optional `owner_mode` desktop preference selects `desktop-embedded` or `standalone-core` for
the next process start; omission preserves the desktop-embedded default. It lives only in Electron
user-data preferences and is not a shared owner configuration or a live ownership transfer. There
is no production settings control for activating standalone-core mode yet.

[Desktop bootstrap](../src/modules/app-shell/services/desktop-owner-bootstrap.ts) branches before
owner-local initialization. Desktop-embedded mode acquires the desktop profile lease before initializing
account security and SQLite. Standalone-core mode skips that lease and initialization, starts or attaches
through the existing service launcher, and verifies the private handshake twice around the profile
owner probe. Compatibility version, ready state, PID, epoch and profile fingerprint must agree.
No raw profile path or credential crosses this handshake. A failed standalone-core startup exits with a
fixed error and cannot open the profile locally.

Only a verified standalone-core owner selects the complete account/configuration/legacy/OpenCode/gateway/
audit/Thought/capture composition, synchronously before MessagePort admission and window creation.
Private desktop requests carry its epoch; a replaced core rejects them before side effects. UI
preferences, windows, tray, updater, chooser and shell effects remain desktop-local. Standalone-core mode
does not start the desktop-embedded gateway or account monitor. Development launch uses Node on PATH and
`dist/core/main.cjs`. Packaged launch resolves `resources/standalone/node/node[.exe]` and
`resources/standalone/core/main.cjs`; missing resources fail closed.

Forge's pre-package hook composes standalone resources through the owning preparation script.
The Windows x64 MSI uses explicit x64 metadata and a stable upgrade family; product codes remain
unique per build. Existing Squirrel installations continue through Electron's native Squirrel
updater and the Squirrel package/feed with the same package identity. The NSIS installer is built
from the packaged Electron app and uses `electron-updater` with a separate architecture-specific
feed. Installed NSIS builds download a verified `.exe` in the background and offer a restart action
after the download completes. Install format is detected from installed package markers; MSI and
unpacked builds use the manual release path. The MSI family applies to MSI-to-MSI upgrades;
historical random-family MSI and cross-installer transitions require independent migration evidence.

Linux AppImage builds use an app-shell-owned `electron-updater` service. Only a packaged,
writable AppImage with a matching ELF architecture activates it; DEB, RPM and unpacked builds
use the manual release path. The service downloads a complete archive from the published
architecture-specific `latest-linux*.yml` feed, verifies it through the updater library, and
offers an explicit restart action. Ordinary quit does not install an update. The existing
desktop shutdown coordinator closes the gateway and profile owner before replacement and
relaunch. Forge packages the updater cache configuration and includes only AppImage assets in
Linux updater metadata. Download failures expose retry and manual-download actions.

Update notices offer an on-demand release-notes dialog before installation and during background
downloads. The app-shell main process reads the selected tag's `updater.json`, checks its version,
and falls back to the GitHub API for that exact tag when metadata is missing, invalid or contains
the legacy placeholder. The publishing workflow copies the Release body into metadata through
[the metadata generator](../scripts/generate-updater-metadata.mjs). Description retrieval uses a
separate typed app-shell ORPC operation and does not alter installer feeds or update policy.
An open dialog stays attached to its selected release, while cancellable query state is cached
only in renderer memory by tag. The dialog distinguishes empty descriptions from retrieval
failures, provides retry and release/history links, and leaves download and installation available.
Closing details does not dismiss the update notice; manually checking again restores a dismissed
notice for an available update. Editing a published Release body requires resynchronizing its
metadata asset for the preferred source to reflect that correction.

The runtime pins Node 24.19.0, verifies its official download checksum and installs the checked-in
production dependency lock in an isolated directory. The pinned build-only `@vercel/nft` tracer
retains the built core, CLI and worker dependency graph, explicit target-native binaries and licenses.
Tracing is restricted to the staging root and rejects unreviewed missing-dependency warnings.
Node-native rebuilds never target the
workspace's Electron dependency tree. Core, CLI, both diagnostic workers and assets ship outside
the Electron ASAR with their own `node_modules` and a resource manifest. Core startup requires both
worker entries before admitting an owner. Cross-platform or cross-architecture native preparation
requires a matching build host. Source maps from the core/CLI builds are excluded from these resources.

Desktop and standalone core use separate rotating log files and rotation audit files (`app` and
`core` prefixes), preventing both processes from managing the same retention ledger.

Desktop shutdown closes renderer admission and presentation polling, then drains accepted
handlers before detaching. It requests core shutdown only for the exact live process it launched;
external and competing owners stay alive. A launched core is awaited through management closure
and profile lease disappearance. Standalone-core cleanup has a 30-second desktop bound; desktop-embedded cleanup
retains three seconds. A closing management connection is observed again without replaying
shutdown. Windows x64 packaged and MSI-installed runs verify native SQLite, synthetic credentials
through the real OS keyring, both Electron ownership modes and abnormal process recovery. Live
providers and macOS/Linux packaged behavior remain separate release evidence.

## Process ownership

| Area                              | Owner                                                                                 | Responsibilities                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Main-process bootstrap            | [src/main.ts](../src/main.ts)                                                         | Electron lifecycle, windows, startup configuration, tray, updates, database initialization, gateway startup and shutdown |
| Standalone core bootstrap         | [src/core/main.ts](../src/core/main.ts)                                               | Explicit Node process startup, persistence and gateway lifecycle, local management endpoint                              |
| Core application RPC              | [src/core/rpc](../src/core/rpc)                                                       | Typed oRPC transport over the private management pipe/socket, safe read projections and gateway lifecycle operations     |
| Profile ownership                 | [src/core/ownership/profile-lease.ts](../src/core/ownership/profile-lease.ts)         | Cross-runtime local endpoint lease and bounded owner identity probe                                                      |
| Node CLI                          | [src/cli/main.ts](../src/cli/main.ts)                                                 | Local service discovery, detached launch, status and graceful stop                                                       |
| Preload bridge                    | [src/preload.ts](../src/preload.ts)                                                   | Minimal context-isolated renderer API and ORPC MessagePort handoff                                                       |
| Renderer bootstrap                | [src/renderer.ts](../src/renderer.ts)                                                 | Renderer observability initialization and React application startup                                                      |
| ORPC composition                  | [src/ipc/router.ts](../src/ipc/router.ts)                                             | Global middleware and composition of feature-owned routers                                                               |
| Desktop-embedded server bootstrap | [src/server/main.ts](../src/server/main.ts)                                           | NestJS/Fastify construction, server lifecycle and transport adapters                                                     |
| Server module composition         | [src/server/app.module.ts](../src/server/app.module.ts)                               | Composition of proxy-gateway server modules                                                                              |
| Application routes                | [src/routes](../src/routes)                                                           | File-based route definitions                                                                                             |
| Router construction               | [src/modules/app-shell/routing/routes.ts](../src/modules/app-shell/routing/routes.ts) | TanStack Router instance and history configuration                                                                       |
| Shared database primitives        | [src/shared/persistence/database](../src/shared/persistence/database)                 | SQLite connection, schema and generic row validation                                                                     |

## Dependency direction

Dependencies should move from presentation and composition toward owned capabilities:

```plaintext
routes/components -> feature hooks/actions -> feature services/repositories
renderer -> preload contract -> IPC/ORPC -> feature handler/service
main bootstrap -> module composition -> feature lifecycle service
feature persistence -> shared database primitives
server bootstrap -> proxy-gateway server module
```

The following reverse dependencies are not allowed:

- `src/shared` must not import a feature module.
- A feature module must not depend on another feature's private implementation merely to reuse a helper.
- Renderer code must not import Electron main-process, database, filesystem, keyring, or server implementation modules.
- Feature behavior must not be implemented in the root ORPC router or server bootstrap.
- Shared infrastructure must not acquire product behavior that has a clear feature owner.

When a capability genuinely has multiple consumers, expose a narrow shared API or move the capability to `src/shared`. Do not move code pre-emptively based on hypothetical reuse.

`npm run verify:boundaries` derives a runtime import graph from the current Git worktree and reports violations of these rules. `npm run verify:boundaries:enforce` rejects renderer/preload main-process reachability, reverse `shared` dependencies and root IPC imports of feature internals. [src/ipc/router.ts](../src/ipc/router.ts) may compose feature router exports but may not import feature handlers, repositories or services directly.

## Feature ownership

Feature-specific components, hooks, IPC routers, services, persistence and types live under `src/modules/<feature>/`. The current feature owners are:

- `account`: local account snapshots, Antigravity state backup/restore and account UI.
- `antigravity-runtime`: process discovery, startup, switching, client credential storage and runtime patching.
- `app-shell`: window, tray, theme, routing, updates and application-wide UI actions.
- `cloud-account`: cloud authentication, monitoring, quota, import and persistence.
- `config`: application configuration and its IPC/UI surfaces.
- `identity-profile`: identity profile behavior and dialog UI.
- `proxy-gateway`: local HTTP gateway, protocol mapping, model routing and gateway administration.

Generic UI primitives belong in `src/components/ui`; application-wide composition belongs in `src/components/layout` or `src/components/shared`. A component stays in its feature when its language or behavior depends on that feature, even if it is visually reusable.

## Antigravity process operations

The `antigravity-runtime` module owns executable discovery, bounded process observation, context capture and operation coordination. Windows and Linux start the selected executable directly with array arguments and detached, ignored stdio; macOS opens the selected application bundle. Windows GUI launches leave `windowsHide` disabled so the application's initial window can appear. WSL selects native Linux observation for an explicitly configured Linux executable, or Windows observation for a mounted Windows executable; absent explicit configuration, existing Windows discovery remains the default. Ordinary startup does not send an OAuth URI. Process observation requires the application name or a configured executable match; mentioning Antigravity in an unrelated editor's arguments does not identify an application process.

A GUI switch captures the executable, configured arguments and effective user data directory before closing the app. Executable and directory conflicts fail before closing or writing account data. Canonical paths identify symlink aliases; a Linux CLI wrapper is equivalent only when the installation layout and product descriptor identify the same installation. Only the necessary user data directory is recovered from a running process. Injection, identity profile updates, version selection and restart receive the same explicit context without later cache or default-directory fallbacks. The `agy` target skips GUI operations.

Native Windows normal close posts `WM_CLOSE` to unowned top-level windows belonging to the verified
client process, including hidden windows. Owned save/confirmation dialogs remain under the client's
control. The runtime confirms exit within the existing deadline and does not force a client that
refuses to close. WSL retains its normal taskkill transport. A cloud switch whose close cannot be
confirmed reports `process-close-failed`, with guidance to save work, resolve confirmation dialogs
and close the client before retrying. Client credential writes and active-account updates wait for
confirmed exit on the restart path.

Running native IDE instances with supervised workspace AI services use hot switching for cloud accounts and local authentication snapshots. An IDE with a machine AI service launched directly by its main process (the IDE subclient without LSP enabled) uses a full restart: that service has no automatic exit recovery, and restarting a workspace service with the same executable cannot restore its endpoint. Preflight selects the normal close/write/start flow before account writes or service termination. No extension, version blacklist or operating-system blacklist is used. The captured IDE is closed, the account is written, and one launch is confirmed without retrying an uncertain launch. The runtime revalidates the captured main processes, writes the identity profile and credentials, terminates only dedicated AI `language_server` descendants through Node's native process API, and reasserts credentials after termination. It allows five seconds for service exit and fifteen seconds for replacements. Confirmation requires every captured service to disappear, a replacement of each executable to appear, and the original main-process identities and profile context to remain unchanged. Idle services can retire without restoring the previous instance count. A query reaching the recovery deadline reports unconfirmed recovery; an earlier query failure aborts. Successful hot switching leaves the main window, terminals and other language services running. AI requests already in progress may be interrupted by the service restart. Service recovery failure uses one full restart after revalidating the main window; an observed user-closed or replaced main process aborts without reopening it. Failed writes or uncertain process queries report partial completion without updating success metadata. Process replacement confirms service lifecycle, not the account displayed in the official UI or readiness of an AI request. Classic, stopped IDE instances, and WSL observation of Windows applications retain the restart path. The operation remains `switching` throughout hot switching and any fallback.

One launch command is followed by process confirmation with a six-second deadline. A matching main-process identity must remain present across successful observations for at least one second; disappearing processes, replacement identities and inconclusive probes reset confirmation. This establishes sustained process presence, not window visibility or signed-in account identity. Native process queries use the published read-only `@draculabo/sysinfo-process-enhanced` dependency. Its worker snapshots preserve argv boundaries on Windows, Linux and macOS. The library owns independent caller deadlines and merges overlapping native scans; the Manager adapter validates returned metadata and its consumers select application processes. npm installs the matching prebuilt platform package, and Forge's AutoUnpackNatives plugin unpacks its `.node` binary. Ordinary native status observation is capped at one second; startup confirmation and native shutdown observation use the remaining operation budget. Expired results are discarded, including startup snapshots delivered after the six-second deadline; the OS refresh itself cannot be forcibly interrupted. Only WSL observation of Windows applications retains a bounded PowerShell/CIM bridge. Ordinary WSL Windows status probes allow 4.5 seconds; startup probes receive the remaining confirmation budget. The deadline starts after dispatch; preflight discovery and the renderer's next status refresh add to the visible operation time. Failure reports startup as unconfirmed and never dispatches a second launch. When account data has already been updated, the error explicitly reports partial completion; it does not roll back or report a successful account switch.

Windows update installers are excluded from client discovery and exit confirmation. On native Windows, a running installer for the selected target blocks switch-context preparation. Classic and IDE installers are checked separately. Dispatch reuses the captured launch context without a second installer scan after normal close. Manager does not close installers or retry installation; users finish or resolve a detected client update before retrying.

Product-version caches fingerprint only the installation metadata read on the current platform:
the executable on Windows, the executable and bundle plist on macOS, and the executable and
package metadata on Linux. Windows version probes do not inspect another application's ASAR
archive, because Electron's archive filesystem can retain a handle that blocks client updates.

The main process reserves the selected target before switch preflight. A global switch owner protects credentials and CLI files shared by targets; another switch reports busy immediately and is never queued. Concurrent starts for one target share the operation; manual start/stop during a reserved switch reports busy immediately. Classic and IDE have independent process-operation state. Internal close/restart runs under the switch reservation, which lasts through startup confirmation. Switch-status diagnostics expose the active owner without queue fields. The feature-owned `proc.getOperation` endpoint exposes only `idle`, `starting`, `stopping` and `switching`. The renderer uses it with local mutation state to disable controls, display loading and surface errors.

Native Windows observation excludes language services with `--clientProcessId`, `--node-ipc` or `--useNodeIpc`, including separated and equals-form arguments. It also walks the full snapshot's parent chain through utility hosts to exclude same-executable descendants of another application candidate, even when they have no known helper arguments. A parent started after its child cannot establish ancestry. Independent roots, different executable paths and explicit user-data-directory instances remain visible to conflict checks. These children reuse the IDE executable without an Electron `--type` and must not count as independent main processes for launch confirmation or shutdown. Windows shutdown invokes local `taskkill /PID` without `/F`, `/T` or remote-host arguments for verified main processes, allowing normal window close handlers and save prompts. It never escalates to forced termination. It confirms exit within the shared deadline before the restart path writes account data. Missing windows, cancelled close prompts and exit timeouts abort without forcefully terminating the client; users must save their work and close it manually before retrying. WSL control of Windows clients follows the same policy. Hot-switch fallback may already have written credentials and retains its partial-completion error. Switch timing traces distinguish an unconfirmed exit from other close failures.

Native observation requires readable executable and argument metadata for visible target candidates. An exiting process can briefly retain its name while losing that metadata. Observation retries only this partial-snapshot condition within its existing query deadline and requires a fresh complete snapshot; it never interprets the unreadable row as absence. Persistent unreadability, enumeration errors and deadline expiry remain explicit probe failures.

Native Linux shutdown captures descendants of the verified main processes before sending `SIGTERM` to those main processes. Initial claim and subsequent snapshots compare executable paths and startup timestamps before signalling a captured PID. It allows two seconds for graceful shutdown, then sends `SIGKILL` to captured survivors from leaves upward. Reparented descendants remain tracked; unrelated processes with similar names are excluded. Shutdown succeeds only when the captured tree disappears and a fresh target query confirms no main process remains within the operation deadline. Native Windows `taskkill /T /F` uses `C:\Windows\System32\taskkill.exe` when present and falls back to `taskkill.exe` otherwise. A native Windows command failure requires fresh process observation within the remaining deadline: an already absent main process proceeds to final exit confirmation, while a surviving process or exhausted deadline reports failure. WSL Windows interop retains `/mnt/c/Windows/System32/taskkill.exe` and reports command failures directly. Both use the remaining shutdown deadline rather than the shorter process-query budget and never retry another command.

## Client account storage

Internal Cloud Code generation uses the Daily endpoint first, then the production endpoint.
Explicit `PROXY_INTERNAL_BASE_URLS` or `ANTIGRAVITY_INTERNAL_BASE_URLS` values retain their
configured order. Endpoint failover preserves the account and request; account rotation remains
owned by the existing retry policy. A recovered upstream 429 remains visible in traffic audit.

Both cloud switches and local snapshot restores use the runtime-owned prepared account writer. Preparation validates a detached credential copy, captures one destination, and checks existing SQLite state before closing the application or updating account state. Reassertion during hot switching reuses that writer. IDE writes SQLite UnifiedStateSync; Classic version 2 and later write system credentials, while earlier Classic versions write SQLite UnifiedStateSync. CLI writes system credentials and its local session and Google OAuth files. If Classic's version is unavailable, the resolved installation's existing database selects SQLite; otherwise it selects system credentials.

SQLite writes run in one transaction, preserve unrelated OAuth topic rows, replace OAuth and minimal user identity, write or clear the account's enterprise project, and remove obsolete jetski and cached authentication state. Missing project data clears the previous account's project. New installations initialize the database; damaged existing databases fail preflight. Each prepared writer takes one online recovery backup before its first write, including WAL changes, at `state.vscdb.account-switch.backup`. It never injects into the client's `.backup` database. Primary-store write/readback failure reports failure even when a backup exists. Credential-store writes also require matching token readback; explicit CLI switches propagate required file failures. Windows reads and writes the exact generic credential target `gemini:antigravity` through `CredReadW` and `CredWriteW`, using the existing Koffi dependency. Credential reads never construct or replace an entry. Keytar uses a different `service/account` target and cannot implement this contract. Local vault calls and `GetLastError` run on the same thread; returned native allocations are freed after decoding. Snapshot capture and local discovery await credential reads, and required credential writes finish before client-file synchronization and readback.

Local account files retain the version `1.0` snapshot envelope and normalize historical jetski tokens into the same write contract. New files encrypt the whole envelope with the existing Manager master key and use atomic private-file replacement. Historical JSON is read without rewriting it. Native credential snapshots encode tokens into the existing UnifiedStateSync snapshot fields. Snapshot validation and decryption precede shutdown; no current account state supplies missing snapshot credentials or project data.

Windows version discovery reads the executable's PE resource through asynchronous Koffi calls to `version.dll`. Other platforms read installation metadata; macOS binary plists use a bounded `plutil` query. Discovery never starts the application. Version results are cached by executable and metadata file identity; overlapping probes share work, callers have a 2.5-second deadline, and a timed-out native probe retains its slot until completion. Synchronous request construction reads only an already populated cache.

## IPC and validation

Feature modules own their routers and schemas. [src/ipc/router.ts](../src/ipc/router.ts) composes those routers and applies global error handling; it must not become a second service layer.

Validate data at runtime boundaries: IPC/ORPC inputs, persisted data, configuration, external HTTP responses before trusted use, process or worker messages, and filesystem content. Same-process values already constrained by precise TypeScript types do not need duplicate validation.

Errors crossing into the renderer must preserve actionable public information without exposing credentials, raw authorization values, or unnecessary internal state. Feature services own domain error meaning; the global router owns transport-safe conversion.

## Desktop-embedded proxy gateway

The proxy page's service control shows an account-risk notice before the first manual start. Only explicit confirmation records the versioned acknowledgement in the renderer profile's local storage and dispatches startup; dismissing the dialog does neither. Later manual starts reuse that acknowledgement, while stop remains available without it. If preference storage is unavailable, confirmation applies to the mounted control and the notice reappears after remounting. Pending start/stop operations disable the control and display loading. This UI notice does not change gateway IPC contracts or application auto-start behavior.

The Electron main process starts and stops the NestJS/Fastify gateway through [src/server/main.ts](../src/server/main.ts). Protocol controllers, mappers, routing, quotas, retries, streaming state and provider adapters belong under `src/modules/proxy-gateway/server` or another proxy-gateway-owned directory.

Audit and thought management query/path parameters use their existing Zod schemas
through the gateway's [Zod parameter Pipe](../src/modules/proxy-gateway/server/common/zod-schema.pipe.ts).
Validation preserves coercion, defaults and bad-request envelopes. Body chunk
requests validate the path UUID before reporting query errors.

Batch, ordinary Files, OpenAI Uploads and legacy Anthropic completion handlers declare their existing dialect error mapper
through [ProtocolErrors](../src/modules/proxy-gateway/server/common/protocol-errors.decorator.ts).
Its Interceptor maps handler failures into HTTP exceptions; guard authentication
failures keep their existing handling. Ordinary methods return protocol objects,
with POST success explicitly set to 200. Anthropic JSONL results keep manual
response handling, as do Files content downloads. Files upload annotations retain
upload-only error normalization; Uploads normalizes only multipart part errors.
The shared `/v1/files` entry selects its error
dialect from each request. Anthropic beta checks and multipart/raw-media parsing
remain explicit in the Files controllers. Gemini model-entry batch submission
keeps its existing adapter. Retry, account leases, cancellation and cleanup remain
in their owning execution paths.

The non-streaming Anthropic `/v1/complete` entry assigns its `request-id` header
explicitly with a passthrough reply. Its error mapper reads that header to keep
the error body's `request_id` correlated with the same response. Prompt conversion
and stream refusal stay in the handler. Gemini model list/detail entries return
their existing objects, including HTTP 200 fallback metadata for unknown models.

Stored Responses read/delete handlers return their existing protocol objects and
use Nest's not-found exception with the OpenAI error body for missing records.
Unexpected store failures retain the framework's error handling. Response
generation, continuation and durable storage remain service-owned.

Thought management mutations declare their existing success-only administrative
audit through [AuditAdminOperation](../src/modules/proxy-gateway/server/modules/observability/admin-operation-audit.decorator.ts).
Each single-result handler finishes its mutation before the Interceptor records
the operation and its affected count. Validation, authentication and mutation
failures do not generate a successful audit event; recorder failures still
propagate. Audit-store mutations retain their service-owned auditing, and client
thinking endpoints retain explicit recording of counts absent from their response.

The Anthropic mapper's system-instruction normalization removes complete Claude Code billing
metadata lines before constructing the upstream request. This also applies to OpenAI requests
that use the same normalization path. Fenced and inline code, user/tool messages, tool definitions
and thinking signatures are preserved. Native Gemini entry points are outside this filter.
The [billing metadata Agent Note](../.agents/notes/implemented/bug-fix/2026-10-04-claude-code-billing-metadata.md)
records the paired live-provider evidence and the deliberately narrow scope.

Explicit HTTP 400 upstream errors naming an invalid thought signature, its field path, or an
invalid signature in a thinking block invoke the existing single recovery attempt before any
client stream event. The classifier also handles provider errors nested as JSON text inside a
Google error message. Recovery retains the account and physical model; other signature errors
and non-400 responses do not qualify. The
[signature recognition Agent Note](../.agents/notes/implemented/bug-fix/2026-10-04-thinking-block-signature-error.md)
records the live failure and the scope of this recognition change.
Recovery removes echoed tool signatures and skips persisted thought replay for that attempt,
including non-stream generation's stream fallback. This prevents the transport from restoring
the just-rejected history. Normal generation retains replay, and persisted thought records are
kept for diagnosis.

Protocol-facing behavior is a compatibility surface. Changes to request mapping, streaming event order, tool calls, usage accounting, error responses, model selection or durable response state require the focused tests listed in [testing.md](testing.md) and may require an Agent Note.

The [proxy compatibility reference](proxy-compatibility.md) describes current Responses history, reasoning, tool configuration and explicit-cache contracts.

## Persistence and credentials

Claude Code and Codex configuration use the proxy-gateway-owned
[tool service](../src/modules/proxy-gateway/agent-tools/agent-tools.service.ts), selected alongside
OpenCode in desktop-embedded or standalone-core mode. Typed RPC exposes bounded status,
connection-only previews and recovery operations; only the selected owner reads files and
connection keys. CLI commands live under `src/cli`. Both shutdown paths close tool admission and
drain admitted work before closing configuration mutation admission, since Codex setup can add
a review route. See [coding-tool-configuration.md](coding-tool-configuration.md) for file ownership
and recovery behavior.

Shared SQLite connection and schema utilities live under `src/shared/persistence/database`. Feature-specific repositories and codecs remain with their feature. Persisted rows are untrusted when read and must be narrowed through the owning schema or codec.

Cloud-account OAuth tokens are stored in the user's local SQLite database as plaintext JSON. Other credentials retain their owning keyring or encrypted-storage policy. Schema, on-disk payload and credential-location changes are high-risk decisions governed by [security.md](security.md).

## Routing and generated files

Route source files live in `src/routes`. TanStack Router generates `src/routeTree.gen.ts`; never edit that file manually. Application router construction remains in `src/modules/app-shell/routing/routes.ts` so route generation and runtime history configuration have separate owners.

## Where new behavior goes

| Goal                                          | Location                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Add feature UI or behavior                    | Owning `src/modules/<feature>` subtree                                 |
| Add a renderer-to-main operation              | Feature IPC schema/router plus typed renderer client usage             |
| Add a gateway endpoint or protocol behavior   | `src/modules/proxy-gateway/server` and the owning protocol module      |
| Add feature persistence                       | Owning feature repository using shared database primitives             |
| Add reusable database infrastructure          | `src/shared/persistence/database`                                      |
| Add a generic UI primitive                    | `src/components/ui`                                                    |
| Add application shell behavior                | `src/modules/app-shell`                                                |
| Add a route                                   | `src/routes`; regenerate the route tree through the existing toolchain |
| Change a cross-cutting architectural decision | Agent Note plus updates to this document and affected contracts        |

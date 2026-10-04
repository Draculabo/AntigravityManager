# Agent Note: Core Application RPC

Status: implemented

## Problem

The standalone Node core owns persistence and the gateway, but Electron's renderer RPC still terminates inside Electron main. Moving Electron ownership before a separate application transport exists would make the desktop either access the profile directly or duplicate state ownership.

## Decision

Host a distinct oRPC application router under `/rpc` on the existing private core management pipe/socket. Reuse the installed Fastify and oRPC server/client packages. A small Node HTTP adapter lets the oRPC fetch client use the local endpoint with finite time and byte limits. The pilot surface contains ping, gateway status, context-cache counters, gateway start/stop and an explicit credential-free cloud-account summary projection. Electron's existing renderer transport delegates the four gateway operations through a feature-owned adapter. Desktop startup selects the embedded implementation. The remote implementation uses the core RPC client and never falls back to embedded behavior on transport failure; it is exercised against the real local endpoint before any ownership switch. A Node-safe lifecycle service serializes gateway start/stop in both hosts. The standalone core refreshes its management status after each remote lifecycle mutation.

Core RPC is admitted only while the core is running. Shutdown closes admission synchronously, drains management requests, then tears down the core and releases profile ownership. A failed management close retains the ownership lease.

Manual quota refresh uses the same feature-owned service in embedded and remote modes. The remote operation returns only the strict cloud-account view and schedules warmup through the core-owned Node runner. Shutdown closes account-mutation admission, cancels the runner, then drains admitted refreshes and warmups before core teardown. Tracking refresh work independently of the connection is necessary because a client timeout can close the socket while the provider operation continues. Quota refresh may make several 30-second provider calls, so its client request and private server connection use a separate five-minute bound instead of the short default RPC timeout. If that bound expires, the core may still finish the admitted refresh; the UI must not infer rollback from a transport timeout.

IDE account sync shares the account adapter and private RPC path. Its import policy remains in the existing Node-compatible IDE adapter, while a feature service projects the result and classifies failures into stable categories. Both the embedded route and core RPC convert those categories to bounded transport errors; the UI localizes the category instead of rendering raw backend messages or stacks. Once IDE sync joined quota refresh as a second long-running account mutation, the core tracks and drains both kinds of admitted work before stopping persistence. The shared account-mutation client uses the five-minute bound. Native SQLite execution and packaged behavior remain release-environment gates.

Security status is read from the selected account owner, since the embedded runtime's key-store state may differ from a standalone core's state. Validation-link lookup similarly stays with the account owner, but only Electron main may open the system browser. The core returns a bounded trusted URL over the private RPC; Electron main validates it again, and the renderer receives a void result with stable, value-free errors. These reads are short and do not need the long-running mutation drain contract. The extra Electron validation is intentional because a remote process response is a trust boundary before an OS-level open action.

Desktop Google login reuses the owner-side OAuth session model. The old fixed-port callback service sent authorization codes through preload to React, then accepted them again through renderer RPC. That flow exposed transient credentials to the least-trusted process and depended on a live window to finish login. The renderer now calls the account adapter for one complete login operation. Embedded composition opens the browser and waits on its local session; remote composition starts and polls the core's management session and obtains the strict account view through core RPC. Both return only the strict view or a stable failure code. The remote start request captures an explicit client key atomically, while a separate owner-side preference write preserves desktop selection behavior. The core accepts idempotent, session-scoped cancellation of a pending callback listener but finishes enrollment already admitted. Successful embedded enrollment retains the existing conditional tray update and refreshes the gateway account cache. Desktop shutdown drains embedded enrollment before gateway teardown and only cancels its pending remote session. Electron still selects embedded account ownership.

Cloud-account switching moves its existing orchestration into a Node-safe feature service. The desktop adapter supplies a tray notification after success; the remote adapter calls the core through the private RPC and does not fall back to embedded persistence. The selected owner keeps the switch guard, target routing, token refresh, device profile, process lifecycle, injection and active-account writes together. Both transports validate the request and expose only stable error categories. The core includes switches in its long-running account-mutation admission and drain set. Desktop quit closes local switch admission and waits for admitted work under the existing three-second forced-exit bound. That bound can interrupt a long switch; after restart, the user may retry and the persisted active-account state remains the source of truth. The ownership selector remains embedded until the other direct account capabilities have remote paths and packaged runtime gates pass.

Cloud-account identity-profile operations use one Node-safe owner service behind the account adapter. Snapshot and preview remain reads; binding, revision restore and deletion join the core's admitted mutation drain. Strict, bounded profile schemas are transport-only, preserving the existing legacy normalization of stored profile and history records rather than changing their durable format. The renderer intentionally receives the requested machine/device identity fields, while internal storage paths and errors collapse to stable categories. Opening the storage folder remains a local Electron shell action. Electron continues to select embedded ownership until the remaining direct capabilities and release gates are complete.

## Alternatives considered

Monitor policy remains in its feature service while Electron notification construction moves to desktop composition. The owner scheduler and target switch policy must run in the same process as account persistence; moving only force-poll RPC would leave recurring maintenance on the wrong repository. Core startup therefore synchronizes its schedule after acquiring ownership and opening management, and shutdown closes monitor admission before draining polls and warmups. Desktop focus is gated by embedded ownership and explicit refresh uses the selected adapter. Configuration writes are bounded independently from compatible saved reads to preserve the private control request limit. Existing durable settings codecs remain unchanged. The core deliberately has no OS notification delivery; remote desktop notification parity uses the bounded presentation surface described below, without transporting raw accounts. The actual owner selector and native release gates remain subsequent slices.

Cloud file import/export moves to the selected account owner without sending documents through application RPC. The existing importer accepts 5 MiB, larger than the private control request limit, and exports may include refresh grants and authenticated proxy URLs. Raising the global RPC cap or returning JSON to React would expand both the control and credential surfaces. Electron main therefore selects a file and passes only the bounded path/options to the owner. The import strategy dialog now precedes the system chooser; cancellation performs no repository work. Failure details are capped at 100 records while a separate failed count preserves the total. Existing merge/overwrite behavior, stripped-import token preservation, profile/history/proxy fields and same-grant OAuth-block semantics stay unchanged. Successful writes schedule post-import work in the owner, and remote import joins mutation drain. Atomic export preserves an existing backup when replacement fails. No durable account format or schema changes are introduced; Electron remains embedded, so rollback is the prior desktop composition rather than a dual-write path. Full native installer, Node SQLite and live OAuth validation remain release gates.

- A second TCP server would widen the reachable surface and require another authentication scheme.
- Importing the existing Electron router would pull clipboard and other desktop-only implementations into Node.
- Returning full cloud-account objects would expose access and refresh tokens across a new process boundary.
- Automatically falling back to embedded operations after a remote failure could hide split ownership and show stale state.

The remote presentation gap is covered by a feature-owned bounded journal and Electron main pump. Reusing the existing private read-only transport avoids adding a general event bus or durable delivery queue. The journal retains 128 hints and serves 32-entry batches with an epoch and monotonic cursor. Losing hints during overflow or restart is acceptable because current owner views remain authoritative; historical switch hints update the tray from the current active view. Notification errors are isolated from polling and successful switch persistence. The remote pump suppresses duplicates, stops before shutdown drain and never falls back to local repositories. Embedded effects remain direct. Tray actions now delegate to the selected owner, including the full account-switch policy rather than a local active-flag write. Selector activation and native release gates remain outstanding.

Local-import transport reuses the existing coordinator and credential-validation/import policy in each owner. The renderer keeps its UUID-only confirmation contract. A bounded Electron capability registry binds preview and post-import task IDs to the exact selected adapter instance, while random owner-local UUIDs and session clearing make old core sessions unavailable after restart. Coordinator admission and a generation guard prevent late discovery/validation from exposing a new secret-bearing session during shutdown, including close/reopen races. Confirmation is consumed synchronously before persistence, tracked by account-mutation drain, and followed by owner-side post-import drain. Strict output bounds may reject unusually large discovery summaries instead of increasing private RPC limits. No discovery algorithm, durable account format or encryption location changes are introduced. Selector activation and native release gates remain.

Switch diagnostics use the selected account owner. Metrics, guard queues and device hardening are process-local instrumentation; hardening is not a machine-wide durable record. The public response states this provenance and includes a volatile epoch so a restarted owner does not appear to continue Electron counters. Recent raw failure messages are replaced by fixed text and closed reason/stage categories. Queue hints are capped while preserving their total count. Hardening snapshot reads no longer mutate expiry state; the actual apply policy retains its existing expiry behavior. Diagnostics stay outside mutation admission/drain. Owner selection and the native release gates remain separate work, and cutover still requires auditing other direct profile users.

The [cutover audit](../../../../docs/ownership-cutover-audit.md) found broader direct profile consumers after cloud-account migration. Switching the selector now would conflict with the desktop lease/bootstrap and leave legacy account, combined configuration, audit/thought and OpenCode operations on local persistence. The decision is to keep embedded selection and migrate these owned subsystems separately, rather than infer whole-application readiness from cloud-account tests or summary-only review. Native release gates remain additional requirements after the ownership audit is clean.

## Consequences

Configuration migration retains `gui_config.json` as the owner's durable runtime/proxy source and preserves its existing compatibility/migration behavior. A serial owner queue covers validation, persistence, runtime application and shutdown drain. Runtime application receives a separate config object and reports `restart-required` after a durable write when application or live-port checks fail; it does not pretend to roll back persisted state. API-key generation and executable-path reads use this selected-owner boundary. Normal snapshots omit keys and upstream URLs; explicit reveal preserves the existing copy/view flow without caching secrets.

Desktop preferences move to versioned `desktop-preferences.json` under Electron user data. Only the first creation seeds desktop fields from legacy GUI config; all later writes stay local, including offline changes. Corruption fails closed rather than reseeding privacy consent. This is a one-way preference split: an older build may display legacy preference values rather than the newest desktop values. Runtime/profile rollback retains the existing owner format; there is no dual-write compatibility path. Effective quota/credit alert policy stays in its existing SQLite settings, because old GUI alert fields were not the monitor's authoritative source. A separate selected-owner policy API preserves that behavior and writes multiple policy fields in one transaction.

The configuration update route has a scoped 128 KiB allowance with encoded schema bounds; all other private requests retain 4 KiB. Secret writes are separately bounded, and configuration routes bypass audit middleware to prevent logging secret interaction payloads or opening local audit workers. No npm dependency is added. Tests use real private RPC transport with isolated persistence/provider fixtures; actual Node SQLite, keyring, live OAuth and packaged installers remain separate release gates. Remote selection is still blocked by the remaining ownership audit rows.

The gateway adapter can use the new client when Electron ownership moves to the core. The current desktop still selects embedded mode and owns its existing persistence and gateway. Lifecycle mutations are serialized and core management status reflects the actual gateway after each mutation. Large account lists exceeding the local response cap fail closed. The cloud-account repository still performs its established decryption and migration behavior inside the owning core process.

## Verification

Legacy local-account migration extracts existing policy into feature-owned Node services and routes the active snapshot/switch/delete/identity flows through one selected owner. Backup restoration remains ID-based and owner-local; no new import/export feature or cloud-import pipeline is introduced. The two raw backup/restore renderer actions had no production consumers and are deleted rather than retained as secret-bearing compatibility routes. Normal views omit backup locations while preserving intentional device metadata with separate transport bounds. The durable account index/history/backup codecs and SQLite-versus-native credential policy remain unchanged. Reads and serialized mutations are admitted and drained before teardown, including switch completion/index reconciliation. Native handles continue using existing per-operation cleanup. Electron still selects embedded ownership; whole-application cutover remains blocked by audit/thought, OpenCode, desktop bootstrap and packaging/native gates.

- Real local pipe/socket tests cover typed operations, readiness, shutdown admission and bounded transport failures.
- Gateway adapter tests cover embedded result parity, remote renderer calls over the real private endpoint, and failure without embedded fallback. Lifecycle and core tests cover mutation serialization and management-status coherence.
- Projection tests prove token fields are excluded.
- Type, runtime-boundary, build and Agent contract checks cover the new module graph.

## OpenCode integration owner

The selected owner runs the complete existing integration policy, including status and installation detection, external configuration preview/sync/restore/clear and dedicated-key revocation. Its external auth-plugin v3 file requires refresh grants; transferring those grants to Electron or redesigning plugin authentication would expand this migration beyond its current contract. The Node owner therefore writes the existing plugin file locally and returns bounded metadata or redacted configuration only. Account selection, backup recovery, dedicated-key reinjection after restore and native keyring location remain unchanged. No Manager-side refresh protocol or new dependency is introduced.

Reads share the serial write queue because status and preview observe configuration/key state. Admission closes before draining every accepted operation, including installation detection, before persistence teardown. The model table has a scoped 128 KiB sync allowance; ordinary control calls retain 4 KiB. Renderer audit hooks bypass these operations to avoid local workers or credential-related administrative payloads in remote mode. Global public-error projection also strips stacks, raw input and causes for migrated configuration, legacy-account and OpenCode operations while retaining validated closed categories. Electron still selects embedded ownership. Audit/thought, desktop bootstrap/lease, native SQLite/keyring and packaged delivery remain subsequent gates.

## Audit management and presentation owner

Ordinary audit reads and mutations use one selected owner and a serial queue capped at 128
admitted operations. This orders repair/delete against reads and ensures accepted database work
drains before persistence teardown. Encoded responses reserve space under the existing control
cap; JSON-expanded body pages defer whole chunks with a continuation cursor. Persisted admin IDs
are not UUIDs and retain their existing `admin:<integer>` contract. The repair result retains its
existing intentional backup location rather than silently removing a renderer contract.

The owner journal retains 128 bounded reference hints, serving batches of 32 with epoch/cursor
reset on overflow or restart. Desktop polling remains sequential, stops at window closure and
discards replies from a replaced owner. Reset means refresh the current view, not replay writes.
IPC capture and Thought Store still need migration, so remote selection remains disabled at
bootstrap. Large content capabilities and terminal worker shutdown remain iteration-22 work.

## Thought and cURL content owners

Thought summaries and maintenance use one serialized owner, preserving owner-local metadata-only
admin recording. The unused all-records IPC route is removed after consumer search; server session
loading remains intact. Explicit record detail preserves all intentional fields and the 64 MiB
thought ceiling. JSON encoding a whole record can multiply control-character bytes, so the owner
retains separate UTF-8 buffers for thought, visible text and signature, returning lengths and
bounded metadata separately. Null and empty signatures remain distinct. Buffer/base64, Zod and
the existing oRPC transport provide the protocol without a new npm dependency or version-sensitive
binary serializer.

Thought and cURL owners each retain at most four snapshots and 256 MiB, with five-minute expiry,
owner epoch/UUID/resource/purpose binding and sequential 64 KiB reads. The combined Thought body
has a new explicit 256 MiB operational ceiling; existing records whose auxiliary visible/signature
content pushes them beyond it cannot be fetched through this transfer. This is a bounded-memory
limit, not a claim that every possible historical payload is migration-safe. A 64 MiB Thought
record and escaped/multibyte fields are covered by runnable tests. Allocation and renderer
assembly can temporarily exceed retained-buffer accounting; native release memory remains a gate.

The cURL owner reuses the existing builder, including 8 MiB body policy and explicit current-key
opt-in. Quoting may expand that body, so the final command has a separate 64 MiB ceiling. Only
Electron main assembles it and writes the clipboard; it is not returned to React. Read failure
requests cleanup, and unavailable cleanup is logged without values while expiry bounds retention.
Snapshots are invalidated after admitted owner work drains. IPC capture remains unfinished, so
this progress does not activate remote bootstrap or complete PLAN22. Terminal store lifecycle
is described below; its native and packaged release checks remain unverified.

## SQLite worker shutdown primitive

Worker closure is terminal per instance and closes admission synchronously. Allowing normal
requests during drain could keep shutdown alive indefinitely; using the public request method
for the final shutdown command would conflict with closed admission. An internal enqueue path
therefore admits only that owner-held command after accepted work drains. One deadline covers
both queue drain and the worker acknowledgement, and native termination is awaited regardless
of protocol failure. Concurrent callers share the result, timeout timers are cleared and failures
are returned after cleanup instead of being silently discarded. Real Node worker-thread tests
cover these races without a native SQLite dependency.

Terminal service shutdown now closes new-work admission and drains accepted audit body/SSE tasks,
Thought hydration and repair under a separate two-second deadline. The existing worker may finish
accepted writes, and an already accepted repair may recreate its worker during that drain. After
drain success or timeout, worker access is sealed before disposal; late callbacks cannot recreate
workers or repopulate Thought hydration memory. Reusable gateway stop and repair remain available
before terminal shutdown. The two real consumers share this lifecycle in their feature-owned
diagnostics module without adding a generic shared service framework.

Core and desktop composition attempt both stores even without a running gateway. Gateway stop
now returns failure when either reusable store close fails. Core retains its profile lease until
terminal diagnostics also succeeds; desktop remains subject to the existing three-second forced
exit. Mocked service/ownership tests cover these cases, and real-thread tests cover the primitive.
Those tests alone do not establish native SQLite terminal drain, packaged timing or remote IPC
recording ownership.

The root IPC audit middleware now delegates its existing policy to one Node-compatible recorder.
It registers admitted handlers before invoking them, preserves route exclusions and asynchronous
parent/attempt/Thought context, and waits for parent completion during desktop quit. Handler errors
remain request errors rather than cleanup failures. This closes the late-IPC-completion gap in the
desktop teardown order without claiming remote recording support: parent capability/context and
large input/output transport remain PLAN22 work, and the 4 KiB ordinary request cap is unchanged.

A separate native lifecycle check reuses core build settings to exercise real services and SQLite
workers under a matching Node binary in an isolated temporary home. Windows Node 24 verification
passed audit writes/redaction, admitted IPC completion, terminal shutdown, old-owner rejection and
persisted audit/Thought/signature reopen. The first fixture used a signature shorter than the
existing 50-character minimum; it was corrected without changing production signature policy.
No desktop native dependency was rebuilt. This evidence covers the service lifecycle, not remote
IPC recording, a full core process, installed artifacts, forced-exit load or other platforms.

## Desktop bootstrap ownership selection

The previous adapter migrations could not be activated safely while main always acquired the
profile and initialized owner security/SQLite. Startup now resolves a desktop-local, restart-only
mode before those operations. Embedded remains the default and retains its owner initialization.
Remote mode verifies management compatibility/readiness/epoch/profile identity against the
profile-owner PID, then synchronously selects every migrated adapter before renderer admission.
Failure never falls back to the local profile.

PID alone is insufficient after process replacement. Desktop RPC and management requests therefore
pin the verified epoch, and the private server rejects a mismatch before dispatch. Epochs prevent
stale attachment; they do not replace OS endpoint permissions. The profile fingerprint prevents
wrong-profile attachment without sending its location. No durable account/configuration format or
credential location is changed by this handshake.

A launched child's PID determines shutdown authority. External or race-winning core processes
remain independent. Desktop shutdown drains all admitted renderer handlers and stops polling before
closing its own core, then waits for the profile lease after the management endpoint closes.
A reset during management closure is observation uncertainty, so the launcher polls again without
repeating shutdown. The remote desktop cleanup budget is 30 seconds; embedded retains three.

Windows Node 24 process acceptance uses the built core and native SQLite, exercises the selected
remote composition with fail-fast presentation-side SQLite/keytar/Worker sentinels, closes and
reopens persisted audit records, and checks lease disappearance. Its core keytar is an isolated
in-memory substitute. This does not establish real OS keyring, Electron windows, installed resource
discovery, live providers or macOS/Linux behavior. Packaged Node/native composition remains a
release gate; the desktop refuses missing resources. No production UI activation control is added.

## Audit body file export

### Remote IPC recording progress

The explicit remote IPC recorder now creates its parent and mutable attempt/Thought context in
the core. Epoch/UUID capabilities identify that context on private business calls, reject stale
owners and pin the main transport to the initiating endpoint. Capture admission is bounded to 128,
idle capabilities expire after five minutes, and core drain retires abandoned bodies before stores
close. The default desktop selection remains embedded.

The existing main-side incremental serializer performs redaction before transmission. The core
accepts sequential canonical base64/UTF-8 chunks through one 96 KiB request lane, acknowledges
SQLite writes and enforces the existing 100 MiB body storage budget. This avoids buffering an entire
body or writing raw credentials into temporary files. Complete nonoversized digests are verified
by the owner; oversized full hashes necessarily rely on the trusted serializer because the owner
receives only the stored prefix. This is an internal private-process contract, not an untrusted
provider upload API. Queue rejection retains business results and marks payloads incomplete.

Private-endpoint tests exercise large escaped Unicode payloads and owner context with substituted
persistence. Windows Node 24 native service evidence separately covers prepared capture body
storage/redaction and complete reopen. These are separate gates, not full-core/installer evidence.
The initial 512-character path/model/session and 1024-character error bounds did not preserve the
existing producer contract. The remote producer also missed nested request models and omitted
error stacks. Both producers now share the original extraction and sanitized snapshot policy.
Large metadata uses the existing capability's dedicated chunk lane, with 100 MiB per field and
256 MiB aggregate retention rather than arbitrary character truncation. Preparation is not an
executable audit context; input fields freeze when the parent is created, and retirement releases
the reservation. Ordinary control envelopes remain bounded. The separate existing Thought key
normalization remains unchanged; it is not the stored parent session ID.

Logical body tests now cover 100 MiB minus one byte, exactly the ceiling and one byte above it.
Windows Node 24 native SQLite evidence additionally reopens an oversized stored prefix and checks
its complete full-body digest and accounting. These do not measure peak process memory, establish
combined native private-endpoint behavior or validate forced-exit load and other platforms. No
new npm dependency is required for this slice.

The core build explicitly emits both SQLite worker entries. Multi-entry Rollup input requires
Vite's boolean SSR mode; an SSR entry string overrides that input and silently omits workers.
Windows Node 24 verification passed real SQLite initialization, empty statistics and shutdown
for both entries using isolated `better-sqlite3@12.5.0` binaries. The desktop binary uses a
different ABI and failed under plain Node, so it was left unchanged. This evidence does not
cover terminal lifecycle migration, installer artifacts or macOS/Linux execution.

File export is a separate selected-owner capability because audit bodies can reach 100 MiB while ordinary private RPC responses are capped at 1 MiB. Electron captures its adapter before the chooser can yield, and passes only the main-selected absolute destination and body ID. The owner streams body pages into a unique sibling temporary file rather than forwarding the body through React or private RPC. File synchronization, replacement and POSIX directory synchronization follow the existing durable-write semantics; failures after replacement cannot promise rollback. No audit database format or redaction policy changes. New requests stop at admission close, and accepted exports drain before persistence teardown. The desktop forced-exit bound and native SQLite/packaged behavior remain release-environment limits. This completed export subpath does not resolve the remaining audit/thought ownership migration.

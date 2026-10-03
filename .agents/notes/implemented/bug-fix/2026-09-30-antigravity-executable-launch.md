# Agent Note: Antigravity Executable Launch and Switch Context

Status: implemented

## Problem

Issue #325 reports Linux startup waiting on the stdio inherited by the application launched through the registered `.deb` URI handler. Closing the app releases the manager's `exec` callback, after which fallback can launch the app again. The ordinary start URI also invokes an OAuth success event. Independently, account injection and restart previously resolved executable and data paths at different times from a process cache that expires after 60 seconds.

## Decision

Start the selected executable directly on Windows and Linux, and open the selected application bundle on macOS. Ordinary startup does not send an OAuth URI. Detached dispatch with ignored stdio prevents the manager from waiting for application-owned output pipes. Preserve only the necessary user data directory from observed arguments, and carry one immutable context through credential injection, identity updates, version selection and restart. Resolve installation and directory conflicts before closing the application or writing account data. Failed startup confirmation reports an error without launching again.

Reserve the target before switch preflight. A global switch owner protects credentials and CLI files shared by targets; another switch reports busy immediately rather than waiting in a queue. Manual operations report busy while their target is reserved, and simultaneous starts share one operation. Internal close and restart retain the same reservation. Main-process operation state supplies renderer loading feedback, and switch diagnostics expose the active owner without obsolete queue fields.

The startup confirmation deadline remains six seconds after dispatch. Linux/macOS probes are capped at one second. Real WSL measurements showed cold Windows PowerShell/CIM queries taking approximately 3.4 seconds, so Windows-process probes allow up to 4.5 seconds, always capped to the remaining deadline and cancelled when it expires. A one-second cap repeatedly cancelled every Windows query and misreported a running fixture as absent. Preflight discovery and the renderer status refresh add to the visible duration.

Desktop acceptance exposed three additional constraints. WSL must distinguish an explicitly selected Linux executable from Windows interop; otherwise the native `.deb` process is never observed. An unrelated editor with Antigravity in its arguments must not count as the app, so name-based matching also requires the executable name. Windows GUI dispatch must disable `windowsHide`: an actual comparison with the same executable, arguments and environment showed that `SW_HIDE` suppressed Antigravity's first window.

Acceptance through `npm run start` exposed two shutdown defects. Windows termination reused the one-second native query budget, aborting `taskkill` before it completed; termination now uses the remaining shutdown deadline. Native Windows prefers `C:\Windows\System32\taskkill.exe` and resolves `taskkill.exe` by name only when that file is absent. This selected fallback supports other Windows installations without introducing a new system-directory resolver; it depends on the inherited executable search environment. An execution failure is reported without retrying. WSL tool paths are unchanged. Linux immediately killed only the main process and left GPU/network helpers alive while reporting stopped. Linux shutdown now captures the verified process tree, requests graceful exit, and force-cleans captured descendants after two seconds, including descendants reparented during shutdown. Selection follows parent PIDs rather than broad executable-name matching. Executable paths and startup timestamps are verified during the initial main-process claim and subsequent snapshots. A fresh target query after tree cleanup rejects a new main instance rather than proceeding with credential writes. Epoch-second timestamps are not a globally unique identity.

Windows IDE switching exposed another main-process classification defect: seven language-service children reused the IDE executable without `--type`, so eight processes were returned as main instances. Serial `taskkill` invocations shared one ten-second deadline and could exhaust it before closing the actual main process. Native Windows observation now excludes the language-service protocol arguments `--clientProcessId` and `--node-ipc`, including separated and equals forms. A surviving orphan language service cannot confirm startup. WSL observation is unchanged. The fix retains explicit termination failures and the existing deadline instead of increasing it or treating command failure as success.

A follow-up failure returned after approximately 2.9 seconds without killing the command, showing that the initial language-service filter was incomplete. Windows IDE TypeScript servers use `tsserver.js` and `--useNodeIpc`. The earlier filter still returned two such children alongside the real main process. Native Windows observation now excludes that protocol marker and follows parent links through the full snapshot, including utility hosts, to remove same-executable descendants without known role arguments. Independent roots, different installations and explicit profile-directory instances remain candidates so preflight still detects conflicts. Parent startup times guard against stale parent PIDs. Shutdown error diagnostics retain numeric `exitStatus` because the generic `code` field is masked by logging policy.

Running native IDE instances retain their main process during account switching. A captured descendant tree selects only dedicated AI service binaries; credential writes precede termination and must succeed again after termination to counter retiring-service writeback. Identity profiles are applied once on the hot path; credential reassertion does not repeat profile backups. Cloud database backup attempts occur once per operation. Five-second exit and fifteen-second replacement deadlines keep service recovery bounded. Replacement counts and process identities prevent an old surviving service from satisfying confirmation. Failure to recover permits one full restart only while the captured main processes still exist; uncertain queries and user-closed windows report partial completion. Local snapshots restore only authentication keys, making the same lifecycle applicable without replacing the full IDE database. WSL Windows interop cannot establish the same native identities and retains full restart. The existing operation reservation provides loading throughout. This extends the decision for account switching; ordinary startup still never dispatches a second launch.

## Alternatives considered

The query-only native extension is based on Brooooooklyn/sysinfo commit
`537111e259547a217ee46630cf9a921fb8f2a320`. Upstream CPU, memory and system
implementations are preserved; an independent asynchronous process query and its
exports are added. No termination API is exposed. Native queries replace command-based
native discovery and observation. The earlier PowerShell measurements explain the
remaining WSL Windows-interop budget. Diagnostic `startTime` has epoch-second precision
and is not a unique termination identity.

Linux process arguments are read from `/proc` in the added query module because the
upstream sysinfo dependency removes empty arguments. The original implementation
remains unchanged. The extension is published independently as
`@draculabo/sysinfo-process-enhanced`; this repository consumes version `0.1.0`
instead of maintaining a local Rust package. Caller deadlines and scan coalescing
belong to the library, while the Manager retains metadata validation and application
selection. Normal production dependency packaging retains the loader and matching
platform package; AutoUnpackNatives unpacks its binary. The local Rust build and
manual binary-copy hook are removed, avoiding a second source of truth.

- Detach `xdg-open` but retain the OAuth URI: rejected because ordinary start must not emit an auth-success event.
- Add desktop-entry selection as fallback: rejected because executable configuration errors need explicit feedback; desktop entry resolution is a separate feature.
- Automatically launch again after a missed observation: rejected because this can reopen an app the user closed.
- Replay every observed argument: rejected because files, deep links and helper flags can carry stale requests. Configured arguments remain authoritative except for restoring the necessary data directory.
- Queue switches or manual start/stop: rejected because stale requests can run after the user's intent has changed.
- Remove all AppImage-related environment values: rejected because it can discard user-supplied settings. Launch preparation removes only paths associated with the manager's AppImage mount.

- Treat any language service as proof of hot-switch completion: rejected because an old process may survive termination.
- Ignore post-termination credential-write failure: rejected because the selected account cannot then be reliably reasserted.
- Restart on a failed process query: rejected because a user-closed window must not be reopened based on uncertainty.

## Consequences

Process detection can still miss an application on a restricted or unusually slow host. It produces an explicit error instead of guessing or launching twice. Native sysinfo observation preserves argv boundaries; WSL Windows interop retains its separate bounded command bridge. When startup is unconfirmed after injection, account data remains updated and success metadata is not committed. An explicit retry remains available after the operation releases its reservation.

No durable format, database schema, credential location or installed URI handler changes. The process-operation IPC response is memory-only. Current behavior is documented in the [architecture reference](../../../../docs/architecture.md#antigravity-process-operations).

## Verification

- Native Windows hot-switch fixtures pass three consecutive changes with two dedicated AI services (one below a utility host). Measured service replacement takes 4.05, 4.59 and 4.24 seconds; main identity, terminal progress and in-memory workspace survive. Both new services read the selected synthetic account marker. Native Linux under Ubuntu WSL passes the same three cycles in 129, 128 and 127 milliseconds using the published Linux binding in an isolated dependency directory. This does not establish official UI account-switch or provider request readiness. The focused suites cover expired replacement deadlines, surviving old services, PID reuse, mandatory credential reassertion and aborting fallback after the main window disappears.


- The follow-up unknown-worker regression fails against the initial filter by returning a child and its main process. The revised Windows fixture includes a utility host and seven mixed workers and passes three consecutive first-attempt shutdowns in 2.06, 2.14 and 1.75 seconds. All nine fixture processes disappear and exactly three launches are recorded. A read-only check of the currently installed official IDE through the production observer changes the candidate count from three to one and preserves the running main process. These checks do not establish real credential injection or official UI account-switch acceptance.

- Windows IDE language-service regressions fail against the earlier observer: both children are reported as main instances and an orphan incorrectly confirms startup. The native Windows fixture passes three consecutive cycles with seven language-service children per main process. First-attempt tree shutdown takes 1.62, 1.85 and 1.76 seconds; all captured PIDs disappear, arguments round-trip, and exactly three launches are recorded without automatic reopening. This is process-level evidence, not real account-switch or official IDE UI acceptance.

- Review follow-up regressions cover immediate busy rejection across switch owners and targets, release after failure, local snapshot synchronization of the Classic OAuth cache, native identity verification before initially claiming a PID, an application replacement appearing after tree cleanup, and native Windows tool selection with and without the preferred file. They also verify that a command execution failure does not trigger a second command and WSL retains its existing path. Timing traces report `exitUnconfirmed` rather than treating every close failure as a timeout. The isolated launch check includes the native tree module and selects its fixture by full executable path, so an installed application with the same basename cannot satisfy or interfere with the check.

- Real `npm run start` acceptance with the published dependency passes Windows x64 and Ubuntu 22.04 WSLg start, loading feedback, stop and invalid-executable feedback. Windows Antigravity 2.17.0 starts in about 4.8 seconds and stops in about 6.8 seconds; Linux Antigravity 2.19.1 starts in 0.3–0.5 seconds and stops in about one second. These script timings include independent post-operation process checks, not full application readiness. Linux uses the official archive with a registered handler in an isolated XDG profile. A deliberately short-lived executable produces a six-second unconfirmed-start error and records exactly one dispatch. After normal window closure, Windows remains absent at 75 seconds and 61 Linux samples over 61 seconds find no process from the tested installation. Windows development startup requires an IPv4 DNS preference in this host; WSL requires a working isolated Secret Service and the test uses `--no-sandbox`. These checks do not exercise real credential injection or account switching.
- The published `@draculabo/sysinfo-process-enhanced@0.1.0` passes real metadata checks under Node and Electron on Windows x64 and Node on Ubuntu WSL. Spaces, Unicode, quotes, empty arguments, trailing backslashes, parent PID and working directory are preserved. The production Manager adapter also passes the Linux check.
- A real Windows x64 Forge package built from the current source in a clean temporary copy retains the npm loader inside ASAR and automatically unpacks the matching platform binary. A no-window Electron 37.10.3 main-process check loads that packaged module and observes its own process. The temporary copy excludes environment files; macOS, ARM and Linux application packaging remain unverified for this npm migration.
- The empty-argument launch regression failed against the former implementation because it invoked the OAuth URI.
- Focused runtime tests cover one dispatch, confirmation deadlines and cancellation, spawn failures, shared starts, busy errors, path conflicts, immutable data paths, partial switch completion and renderer loading/error feedback.
- The standalone native fixture check runs the production launch/observer/stop modules with discovery restricted to its temporary executable. Linux confirmed startup in approximately 36 ms. WSL direct Windows interop confirmed in approximately 2.1 seconds; spaces, Unicode and quotes survived the argument round trip. Both checks recorded one launch and no reopening after close.
- Actual Windows Antigravity 2.17.0 and Ubuntu 22.04 WSLg Antigravity 2.18.1 from the official `.deb` were exercised through a fresh-source Electron Manager and its real IPC. Empty-argument startup displayed the official application window, concurrent starts shared one operation, incompatible stop requests returned busy, invalid paths failed explicitly, and missed startup confirmation did not retry. Windows path conflicts preserved the running app; manual close did not reopen it after more than one minute.
- The official `.deb` handler was registered in an isolated XDG profile rather than installed system-wide. The old `exec(xdg-open)` path received the OAuth deep link; the launcher exited after about 6.4 seconds, but its stdio callback did not return until about 59.9 seconds. This validates the inherited-pipe failure with the real application. It does not validate Ubuntu 26.04 GNOME/Wayland, macOS Launch Services, a release installer, or native credential-store account switching.

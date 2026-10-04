# Agent Note: Standalone runtime delivery

Status: implemented

## Problem

The remote desktop bootstrap cannot use Electron's executable or SQLite ABI as a standalone Node
runtime. Independent source builds do not establish installed dependency or worker discovery.

## Decision

Forge composes an explicit standalone resource tree before packaging. Pin Node 24.19.0 to the
runtime exercised by native acceptance and verify the official archive/executable SHA-256. Use
the existing npm lock and production install rather than a handwritten dependency resolver.
Rebuild Node-native dependencies in staging, independently of Electron rebuilds. Publish staging
only after native load and entrypoint checks, retaining the previous generated tree until replacement.
Use the existing tar dependency on Unix; Windows downloads the official bare Node executable.
Use the pinned build-only `@vercel/nft@1.11.0` for dependency traversal after the production install
and native rebuild. Trace the built core, CLI and workers, explicitly include the four target-native
loaders/binaries and retain licenses. Reject unknown dependency warnings and restrict tracer reads
to the generated root, including cross-drive Windows paths. The full production tree remains only
in temporary staging until materialization and runtime checks complete.

The initial full-tree Windows artifact contains 56,629 files and approximately 823 MB. Squirrel's
vendored NuGet fails one packaging attempt and a subsequent CPU-active attempt is cancelled after
more than forty minutes. These observations motivate traced delivery; they do not prove the exact
NuGet failure cause. Retest installed behavior before accepting reduced payloads.
Packaging requires a matching platform/architecture build host. Node and Electron retain separate
native binaries. Workers are mandatory before core owner startup, even when diagnostics start disabled.

## Alternatives considered

- Depending on Node on the user's PATH would make the installation incomplete and allow ABI drift.
- Rebuilding the workspace dependency tree for Node would break the Electron native runtime.
- Reimplementing dependency traversal would risk omitting dynamically loaded providers or workers.
- Running acceptance against production credentials or replacing the existing installation would
  add unrelated data risk. Test-only service remapping uses the real OS store under a unique name.

## Consequences

Resources include Node, license, core, CLI, workers, assets, production dependencies and a manifest.
The core/CLI source maps are excluded. Desktop and core rotating logs have separate retention ledgers.
Local packaging can select an isolated output directory and suppress Sentry source-map upload;
release defaults and embedded ownership remain unchanged.

## Verification

The worker resource regression rejects missing entries and directories in place of worker files.
Installed-resource acceptance copies resources outside the repository, removes Node search overrides,
uses actual SQLite and uniquely scoped native OS credentials, then exercises remote composition,
attachment, gateway admission, terminal close, persisted reopen, crash recovery and stale-epoch
rejection. Presentation sentinels execute under Node. Intentional shutdown observations tolerate
both connection reset and broken pipe, because the exiting owner can close the transport before
the acknowledgement is read; this does not retry a business operation or replay shutdown.
Installer upgrade/recovery, large-body RSS, live providers and other operating systems remain
separate release gates; the installed-resource script cannot prove them.

On 2026-09-27, the Windows x64 packaged resource check passes outside the repository with
Node 24.19.0, real SQLite WAL/reopen, synthetic credentials in the real keytar and NAPI OS stores,
remote gateway start/stop and unauthorized rejection, audit persistence, external attachment,
terminal owner release, crash recovery and stale-epoch rejection. Three normally exiting core
processes report peak RSS of 228748, 213884 and 215020 KiB for this small fixture. These numbers
do not establish the peak at the supported body-size limit or Electron presentation memory.

The real Windows packaged Electron check passes embedded and remote window startup, settings
navigation, preference restart, launched-core shutdown, packaged CLI start/stop, external-core
retention and desktop crash/restart without a duplicate owner. The application login settings are
restored after each check. Core loss while attached and subsequent remote restart also pass.
A lease probe can receive an empty response during forced Windows termination. The harness waits
for OS termination and then retries only this transient rejected probe until it observes actual
endpoint absence, with the existing bounded deadline. Persistent malformed endpoints still fail.
The traced Windows artifact contains 3,657 files / 544,833,262 bytes, including a standalone tree
of 3,518 files / 114,078,714 bytes. Actual traced resources pass the outside-repository native checks
and the real packaged Electron lifecycle checks. The configured makers are selected by their
instance names `squirrel,wix`; selecting npm package names constructs default instances instead.
Both configured installers build successfully under the normal Windows user token. Restricted-token
NuGet/Windows Installer failures do not require a vendor NuGet upgrade or disabled validation.

The actual MSI passes isolated host installation, exact repair of a removed Thought worker,
installed native and real-window acceptance, and uninstall with restored shortcuts/login settings.
The existing 0.19.0 Squirrel installation is preserved. The x64 WiX maker now uses a stable upgrade
family and explicit x64 metadata: library defaults otherwise generate a new family per build and
label the x64 payload as x86. This starts a stable family; it cannot retroactively identify historical
random-family MSIs. The upgrade fixture varies only installer version metadata and does not prove
historical schema migrations or Squirrel-to-MSI migration.
The actual previous-patch-version fixture and current x64 MSI pass a same-family major upgrade:
the previous product is unregistered, the current product remains, an external profile marker
survives, exact worker repair succeeds, and installed native and real Electron tests pass. The
test MSI is uninstalled afterward, the application login settings and shortcuts are restored,
and the pre-existing 0.19.0 Squirrel registration remains. A clean current-MSI install, repair
and uninstall also passed separately. These two installer versions contain the same current app
payload; no actual historical 0.19.0 Squirrel-to-MSI transition was exercised.
An initial upgrade fixture incorrectly placed a profile marker inside the installation directory.
The old product was unregistered, but WiX removed that unmanaged file with its installation-root
cleanup. The acceptance fixture therefore uses the actual external-profile layout; this does not
change or weaken installer cleanup policy. User data must never be stored under the install root.

The authentic installed 0.19.0 release is Squirrel, not MSI. The current Squirrel package keeps its
`antigravity_manager` identity. A hash-checked isolated copy of the actual 0.19.0 installation
upgrades through its copied `Update.exe` and the locally built 0.21.1 `RELEASES`/full package.
The upgraded copy passes native SQLite/OS-keyring/core and real Electron embedded/remote/crash
acceptance. The original 0.19.0 install, registration and shortcut stay intact; test-modified
application shortcut and login settings are restored, and the temporary copy is removed. One
initial run exhausted the harness's 8 KiB synchronous output buffer after the new app was already
laid down. Directing Squirrel output to an owned log removes that harness-only limit. This is an
isolated Squirrel-to-Squirrel package test, not a real in-place upgrade, old-profile schema test,
rollback test or evidence that MSI can replace Squirrel. Existing Squirrel users should receive
Squirrel packages; the new stable MSI family serves independent MSI installations until a separate
cross-installer migration is designed and verified.

Three reads of an existing persisted Thought just below 64 MiB pass chunk progression, full hashes,
capability closure, terminal reopen and crash recovery. Maximum observed core peak RSS is 616628 KiB
(about 602 MiB); three reads are not an accumulation/soak guarantee. Large captures submitted through
the background worker queue have a smaller admission budget and can be rejected by existing
backpressure. The read fixture uses the owning repository to represent existing persisted records;
it does not raise queue budgets or claim large-write admission.

Desktop observations report 283748 KiB working set / 287616 KiB peak for embedded main, 278516 /
281868 KiB for remote main, and 220160 KiB idle remote core. Renderer/process-group totals are not
measured. Live OAuth/providers and actual macOS/Linux artifacts remain separate release gates.

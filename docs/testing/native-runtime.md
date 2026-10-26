# Native Runtime and Worker Acceptance

This procedure covers cross-feature worker lifecycle, private transport and core ownership. Read [script instructions](../../scripts/AGENTS.md) and use a runtime whose native ABI matches the built artifact.

Run commands from the repository root unless a step specifies another directory.

## Audit and Thought workers

After `pnpm run start` has built the production traffic-audit and Thought Store workers, run their
native SQLite persistence checks under Electron's matching Node runtime:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& .\node_modules\electron\dist\electron.exe scripts\acceptance\runtime\traffic-audit-native.test.mjs
```

This checks real worker messages, database reopen, body paging, retention and physical disk
reclamation. It supplements, but does not replace, live gateway/provider acceptance.

The persistence suite also checks scoped/global drop-baseline resets, preservation of
request bodies during a statistics-only reset, drop clearing during request clearing,
and bounded eviction of the oldest drop buckets. `traffic-audit-drop-lifecycle.test.ts` exercises
the service through the real weighted parent queue with a synthetic persistence worker.
Controlled replies cover queued writes crossing a reset, failed admission, new drops
during a reset and overlapping reset recovery. The component tests cover pending,
failure, retry and the refreshed counter in both reset entry points.

The persistence leaf `scripts/acceptance/runtime/audit-persistence-native.test.mjs`
also accepts `AGM_AUDIT_WORKER_ENTRY` for its exact saved-session scenario after
`build:core`. It verifies full tenant-key equality, literal wildcard characters,
paging/count, exclusion of sessionless admin events and an unchanged unfiltered
neighbor. The same override selects the rebuilt audit Worker for the other persistence
scenarios; without it, Forge remains the default.
`traffic-clear-interactions.test.ts`, `traffic-table-interactions.test.ts` and
`traffic-route-search.test.ts` cover renderer actions and validation with substituted
IPC; `audit-owner.test.ts` checks selected-owner transport separately. These do not
establish installed rendering, OS pointer behavior or live-profile deletion.

The same persistence leaf's session-snapshot scenario selects the rebuilt Worker.
It checks active-record refusal, stable fingerprints, completed metadata changes,
deletion, unscoped rejection and the 2,000-parent limit. Session export tests verify
atomic destination preservation and selected-core transport separately.
`audit-http-session.test.ts` uses real Fastify hooks and substituted persistence to
check canonical hint/credential scope without provider traffic. It does not prove
old unscoped records have recoverable tenant identity.

The Thought Store leaf `scripts/acceptance/runtime/thought-store-native.test.mjs`
accepts `AGM_THOUGHT_WORKER_ENTRY` after `pnpm run build:core`. Set it to the absolute
`dist/core/thought-store.worker.js` path to run every scenario against that artifact;
without it, Forge remains the default. It covers decode expansion, stored metadata,
complete-read count refusal, exact control-character readback, corruption preservation,
bounded cold suffixes, ownership and reopen. The shared fixture owns disposable
databases, Worker shutdown and cleanup; it does not access real profiles.
Metadata-page cases traverse 700 durable records, exclude a later append from the
initial high-water window and permit a bounded first page above 10,000 retained rows.
Transactional end/delete/clear receipts distinguish sessions and records, preserve
neighbors after reopen and retain rows after an injected deletion failure. Oversized
stored summary metadata is refused before returning it.

The separate `scripts/acceptance/runtime/thought-retention-native.test.mjs` leaf
uses the same optional `AGM_THOUGHT_WORKER_ENTRY`. It checks 128-record cleanup
passes, reader-pinned pauses/resumption, process-local no-progress latching on a
non-shrinking legacy file and protection of recently used sessions. The combined
audit-native entry imports it. These are disposable Worker/SQLite scenarios, not
real-volume-full or long-running RSS evidence.

The admission suite checks a zero-budget refusal, a subsequent accepted write, invalid
budget rejection and retained query/reopen access. The default worker comes from Forge.
After `pnpm run build:core`, select that current artifact explicitly for the isolated check:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:AGM_AUDIT_WORKER_ENTRY = "$PWD/dist/core/traffic-audit.worker.js"
New-Item -ItemType Directory -Force .tmp | Out-Null
$check = Start-Process -FilePath .\node_modules\electron\dist\electron.exe `
  -ArgumentList 'scripts/acceptance/runtime/audit-admission-native.test.mjs' `
  -WindowStyle Hidden -Wait -PassThru `
  -RedirectStandardOutput .tmp/audit-admission-native.log `
  -RedirectStandardError .tmp/audit-admission-native-error.log
Get-Content .tmp/audit-admission-native.log -Tail 20
if ($check.ExitCode -ne 0) { throw 'Native audit admission check failed; inspect both logs.' }
```

Wait for the test summary and process exit; a launched GUI executable alone is not evidence
of completion. Restore temporary environment overrides after the check. The source repository
suite `traffic-audit-disk-admission.test.ts` also requires a matching SQLite ABI but no build
artifact; its own disposable databases cover prefixes, capacity-unknown errors, readers,
read-only connections and denied SSE reconstruction. Workspace Electron SQLite ABI 136
does not load in ordinary Node 24 ABI 137; do not rebuild the desktop dependency tree merely
to run a mismatched source check.

For a retention-only change, run `scripts/acceptance/runtime/audit-retention-native.test.mjs`
with the same Electron command after rebuilding the audit worker. Like the admission leaf,
it accepts `AGM_AUDIT_WORKER_ENTRY` for the standalone core build. Disposable databases
cover old bodies below capacity, global whole-parent cascades with shared body references,
active-request/attempt/payload protection, 70% disk reclamation, free-page reuse, pinned WAL,
no physical progress, separate admin/drop limits and schema-v4 reopen. Controlled yields
exercise a large tied-timestamp backlog, reads/new writes, clear/row-ID reuse, completion
during maintenance and user deletion between batches. These checks do not establish a
maintenance latency bound under production load or downgrade against an older app binary.

`scripts/acceptance/runtime/audit-recovery-native.test.mjs` also accepts that Worker
entry after `build:core`. It checks old-process reconciliation, actual retained
prefixes, same-process replacements, unknown model status, later capacity eligibility,
and recognized archive-file/sidecar accounting without deletion. Source checks in
`traffic-audit-recovery.test.ts` additionally inject a transaction failure to verify
rollback and connection release. Archive inventory and renderer storage feedback
have focused Node tests; they do not establish installed dialogs or real-profile recovery.

`scripts/acceptance/runtime/audit-clear-native.test.mjs` accepts the same built Worker
entry and matching runtime. Its disposable databases exercise scoped clear, stale
queued parent/admin admission, missing-owner writes and all-scope transaction rollback
with an injected SQLite deletion failure. It does not clear an application profile.
`audit-probe-capture.test.ts` checks the real Fastify hooks with injected requests and
a substituted audit owner. `audit-body-export.test.ts` checks bounded saved-body
reads through the real atomic file owner, including a deleted/changed body and an
existing destination. These establish their respective boundaries separately;
they do not establish an installed save dialog or a live export/clear interleaving.

`sqlite-worker-cooperative.test.ts` exercises the real weighted scheduler with a synthetic
thread protocol: reads precede maintenance completion, yielded work retains its capacity
reservation, final errors propagate, and terminal close drains or times out without restarting
the worker. `traffic-audit-worker-dispatcher.test.ts` covers serialized configuration passes,
failed-pass release and interruption on direct shutdown. These complement the production
SQLite worker checks; synthetic thread results alone do not establish disk reclamation.

After `pnpm run build:core`, check the standalone core's built audit and Thought Store workers:

```powershell
pnpm run test:acceptance runtime diagnostics --smoke
```

This checks both emitted worker entries, real SQLite initialization, empty statistics and
shutdown. Run it with a `better-sqlite3` binary matching the executing Node ABI. Desktop
dependencies rebuilt for Electron do not establish plain Node compatibility. Use an isolated
copy of `dist/core` with the same dependency version and a matching native binary rather than
rebuilding the desktop dependency tree. Passing this smoke does not establish database reopen,
retention, terminal owner drain, installer delivery or compatibility on other operating systems.

## Admission, shutdown and capture

For the SQLite worker shutdown primitive, run:

```powershell
pnpm run test:unit --run src/tests/unit/sqlite-worker-shutdown.test.ts
```

This uses real Node worker threads with an in-memory test protocol. It covers admission closure,
accepted-command drain, concurrent closes, missing acknowledgements, termination failure and
forbidden restart. It does not open SQLite or validate terminal feature-service/profile teardown.

For terminal diagnostic-store admission and core ownership ordering, run:

```powershell
pnpm run test:unit --run src/tests/unit/diagnostic-store-shutdown.test.ts src/tests/unit/core-shutdown.test.ts src/tests/unit/gateway-start.test.ts
```

These tests cover lazy stores with no gateway, admitted serialization/SSE finish/Thought hydration,
no worker recreation, both-store cleanup and lease retention after failure. Service worker mocks
supplement the real-thread primitive tests; they do not establish native SQLite, packaged Electron
or the desktop forced-exit timing under production load.

For IPC audit metadata/context and desktop admission/drain behavior, run:

```powershell
pnpm run test:unit --run src/tests/unit/ipc-audit-recorder.test.ts src/tests/unit/ipc-capture.test.ts src/tests/unit/ipc-capture-capacity.test.ts src/tests/unit/core-rpc.test.ts src/tests/unit/desktop-shutdown.test.ts
```

The capacity test sends logical bodies at 100 MiB minus one byte, exactly 100 MiB and one byte
above the limit, checking stored prefixes, full digests and completion accounting without retaining
the entire output in the persistence substitute. Private-endpoint tests cover large session/model
metadata and the existing sanitized error snapshot. These checks do not measure whole-process RSS.

## Native service lifecycle

After `build:core`, run the native diagnostic-service lifecycle check with a matching Node SQLite
binary. It also writes and reopens prepared remote-capture bodies through the real service/worker;
the separate private-endpoint tests exercise transport with substituted persistence. Neither check
establishes installed desktop cutover or full-core process ownership.

The optional runtime root selects an isolated installation of the same locked native
dependency version; omitting it uses the workspace dependency tree.

```powershell
pnpm run test:acceptance runtime diagnostics --runtime-root C:\matching-node-runtime
```

The launcher reuses the core Vite configuration and Electron-import rejection to build a test-only
service entry beside that runtime, then copies the built SQLite worker entries. Its child process
isolates `os.homedir()` before application imports. It opens real databases in the temporary home,
checks audit redaction and IPC completion, closes both stores terminally, rejects old-owner reuse
and reopens persisted audit/Thought/signature records through fresh owners. An oversized logical
body also verifies the real SQLite stored prefix, full digest and partial flag after reopen. The
child has a 60-second deadline for this capacity case. Generated files are
removed only inside the verified temporary directory. It does not start a gateway, management
server or complete core process, access keyring credentials, or validate remote IPC/installer flows.

## Desktop owner bootstrap

For desktop owner selection, run the owning bootstrap, management IPC, launcher and desktop
shutdown tests. After `build:core`, the process acceptance command is:

```powershell
pnpm run test:acceptance runtime bootstrap --runtime-root C:\matching-node-runtime
```

This starts the built standalone core in an isolated home with matching native SQLite, verifies
remote adapter operations and capture, preserves an external attachment, waits for terminal lease
release and reopens persisted audit records. Synthetic Responses rows verify selected-owner
Thought deletion before the first gateway start, after gateway stop and after process reopen,
including exact per-owner receipts and JSON readback. The presentation process has fail-fast SQLite, keytar
and Worker sentinels. The core uses a disposable in-memory keytar substitute; the check never
accesses the real OS credential store. It executes the desktop bootstrap composition under Node,
not Electron windows or an installer. Platform packaging, real OS keyrings and live providers
remain unverified by this command. Child processes have bounded cleanup, and generated files are
removed only from the verified temporary directory. Child APPDATA, LOCALAPPDATA,
USERPROFILE and XDG profile roots also live under that home; the native-entry fixture
checks actual client database discovery before launch. The helper's regression check
executes a subprocess and verifies those roots and cleanup after a representative failure.

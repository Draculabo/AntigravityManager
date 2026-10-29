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

For a retention-only change, run `scripts/acceptance/runtime/audit-retention-native.test.mjs`
with the same Electron command after rebuilding the audit worker. Its disposable databases
cover class priority, physical reclamation, preservation of newer bodies when one body meets
the budget, reclamation of fragmented small bodies before large bodies, cursor progress across
tied timestamps and candidate pages, and in-place index
creation when reopening an existing schema-v4 database. Controlled yield barriers also
verify that reads and new writes complete before the final maintenance reply and that
concurrent clear/row-ID reuse does not remove new records. Row-limit tests also verify that
user deletions between batches reduce the remaining eviction target. It does not establish a
maintenance latency bound under production load.

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
release and reopens persisted audit records. The presentation process has fail-fast SQLite, keytar
and Worker sentinels. The core uses a disposable in-memory keytar substitute; the check never
accesses the real OS credential store. It executes the desktop bootstrap composition under Node,
not Electron windows or an installer. Platform packaging, real OS keyrings and live providers
remain unverified by this command. Child processes have bounded cleanup, and generated files are
removed only from the verified temporary directory.

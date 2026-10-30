import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { z } from 'zod';
import { CASES } from './cases.mjs';
import { gitText } from './run.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const observerPath = 'src/modules/antigravity-runtime/processObserver.ts';
const queuePath = 'src/shared/persistence/sqlite-worker/bounded-sqlite-worker.ts';
const runnerPath = 'scripts/acceptance/accounts/account-switch-acceptance.mjs';
const isolationPath = 'scripts/acceptance/accounts/snapshot-isolation.mjs';

// Only pinned evaluator inputs execute here. Imports are explicit fixture dependencies;
// reviewer samples remain source-only and never execute historical application code.
function historicalModule(revision, file, dependencies = {}) {
  const source = gitText(root, ['show', `${revision}:${file}`]);
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: 'historical.ts',
  });
  const exports = {};
  runInNewContext(
    outputText,
    {
      exports,
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected historical import: ${name}`);
        return dependencies[name];
      },
      process: { pid: 999_999, platform: 'linux' },
      AbortController,
      Buffer,
      setTimeout,
      clearTimeout,
    },
    { timeout: 1000 },
  );
  return exports;
}

test('historical observer rejects helper-as-main behavior and preserves profile conflicts', async () => {
  const entry = CASES.find((item) => item.id === 'same-profile-process-descendant');
  for (const variant of ['before', 'fixed']) {
    const revision = entry[variant];
    let rows = [];
    const errors = { processError: (reason) => new Error(reason) };
    const paths = {
      isWsl: () => false,
      getConfiguredAntigravityExecutablePath: () => null,
      isTargetAntigravityProcessCandidate: (candidate) =>
        candidate.executablePath === '/fixture/Antigravity',
      isConfiguredTargetExecutableProcessCandidate: () => false,
      areExecutablePathsEquivalent: (left, right) =>
        path.posix.normalize(left) === path.posix.normalize(right),
    };
    const runtimePaths = historicalModule(
      revision,
      'src/modules/antigravity-runtime/runtimePaths.ts',
      {
        'node:fs': { realpathSync: { native: (value) => path.posix.normalize(value) } },
        'node:path': path.posix,
        '@/shared/platform/paths': paths,
        './processErrors': errors,
      },
    );
    const observer = historicalModule(revision, observerPath, {
      '@/shared/platform/paths': paths,
      './processErrors': errors,
      './runtimePlatform': { usesWindowsRuntime: () => false },
      '@/shared/platform/nativeProcessQuery': { readNativeProcessSnapshot: async () => rows },
      '@/shared/logging/logger': { logger: { warn() {} } },
      '@/shared/platform/antigravityProcessIdentity': historicalModule(
        revision,
        'src/shared/platform/antigravityProcessIdentity.ts',
      ),
      './windowsInterop': {},
      './runtimePaths': runtimePaths,
    });
    const main = {
      pid: 42,
      parentPid: 1,
      name: 'Antigravity',
      exe: '/fixture/Antigravity',
      cmd: ['/fixture/Antigravity', '--user-data-dir=/profiles/selected'],
      startTime: 1n,
    };
    const helper = { ...main, pid: 43, parentPid: main.pid, startTime: 2n };
    const pids = async () =>
      Array.from(await observer.observeProcesses('classic'), (row) => row.pid);
    rows = [helper, main];
    const check = async () =>
      assert.deepEqual(await pids(), [42], 'same-profile helper is not a main');
    if (variant === 'before') {
      await assert.rejects(check, { name: 'AssertionError', message: /same-profile helper/ });
    } else {
      await check();
    }
    rows = [main];
    assert.deepEqual(await pids(), [42]);
    for (const candidate of [
      { ...helper, cmd: [main.exe, '--user-data-dir=/profiles/other'] },
      { ...helper, parentPid: 1 },
    ]) {
      rows = [main, candidate];
      assert.deepEqual(await pids(), [42, 43]);
    }
    rows = [{ ...main, cmd: [main.exe] }, helper];
    assert.deepEqual(await pids(), [42, 43]);
  }
});

async function maintenanceSequence(revision) {
  const worker = new EventEmitter();
  const sent = [];
  worker.postMessage = (command) => {
    sent.push(command);
    if (command.operation === 'shutdown') {
      worker.emit('message', { id: command.id, result: true });
    }
  };
  worker.terminate = async () => 0;
  const { BoundedSqliteWorker } = historicalModule(revision, queuePath, {
    'node:worker_threads': {
      Worker: class {
        constructor() {
          throw new Error('Historical probe must use the controlled worker factory');
        }
      },
    },
  });
  const owner = new BoundedSqliteWorker({
    databasePath: 'synthetic-only',
    workerPath: 'synthetic-only',
    name: 'historical-queue',
    maxPendingBytes: 100_000,
    maxPendingCommands: 100,
    workerFactory: () => worker,
  });
  try {
    const events = [];
    const maintenance = owner.request({ operation: 'maintenance', payload: null }).then((value) => {
      events.push('maintenance');
      return value;
    });
    const read = owner.request({ operation: 'stats', payload: null }).then((value) => {
      events.push('stats');
      return value;
    });
    const maintenanceId = sent[0].id;
    worker.emit('message', { id: maintenanceId, yielded: true });
    const pendingAfterYield = owner.getStats().pendingCommands;
    const bytesAfterYield = owner.getStats().pendingBytes;
    const readId = sent.find((command) => command.operation === 'stats').id;
    worker.emit('message', { id: readId, result: 'stats' });
    worker.emit('message', { id: maintenanceId, result: { slices: 2 } });
    const result = {
      maintenance: await maintenance,
      read: await read,
      events,
      pendingAfterYield,
      bytesRetained:
        bytesAfterYield > Buffer.byteLength(JSON.stringify({ operation: 'stats', payload: null })),
      dispatched: sent.map((command) => command.operation),
      final: structuredClone(owner.getStats()),
    };
    return result;
  } finally {
    await owner.close();
  }
}

test('historical parent queue retains unfinished maintenance while servicing a read', async () => {
  const entry = CASES.find((item) => item.id === 'sqlite-parent-queue-yield');
  const expected = {
    maintenance: { slices: 2 },
    read: 'stats',
    events: ['stats', 'maintenance'],
    pendingAfterYield: 2,
    bytesRetained: true,
    dispatched: ['maintenance', 'stats', 'maintenance'],
    final: { alive: true, pendingBytes: 0, pendingCommands: 0 },
  };
  const before = await maintenanceSequence(entry.before);
  assert.throws(() => assert.deepEqual(before, expected), assert.AssertionError);
  assert.equal(before.maintenance, undefined);
  assert.deepEqual(before.events, ['maintenance', 'stats']);
  assert.deepEqual(await maintenanceSequence(entry.fixed), expected);
});

function snapshotPreflight(revision) {
  const source = gitText(root, ['show', `${revision}:${runnerPath}`]);
  const ast = ts.createSourceFile(
    runnerPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declares = (statement, name) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    );
  const start = ast.statements.findIndex((statement) => declares(statement, 'ids'));
  const end = ast.statements.findIndex((statement) => declares(statement, 'environment'));
  assert.ok(start >= 0 && end > start, 'Expected the historical pre-runtime runner boundary');
  return ast.statements
    .slice(start, end)
    .map((statement) => statement.getText(ast))
    .join('\n');
}

test('historical acceptance preflight refuses inherited and linked snapshot destinations', async (t) => {
  const entry = CASES.find((item) => item.id === 'acceptance-snapshot-destination');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm historical snapshot '));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const home = path.join(directory, 'home');
  const agent = path.join(home, '.antigravity-agent');
  await fs.mkdir(agent, { recursive: true });
  const external = path.join(directory, 'original.json');
  await fs.writeFile(external, 'original bytes');
  const index = path.join(agent, 'antigravity_accounts.json');
  const accountsFile = path.join(directory, 'accounts.json');
  await fs.writeFile(accountsFile, JSON.stringify(['fixture-a', 'fixture-b']));
  const { assertSnapshotIsolation } = historicalModule(entry.fixed, isolationPath, {
    'node:fs/promises': fs,
    'node:path': path,
    zod: { z },
  });
  const execute = (variant, localSnapshots = true) =>
    runInNewContext(
      `(async () => { ${snapshotPreflight(entry[variant])}\n return 'runtime-boundary'; })()`,
      { assert, fs, home, options: { accountsFile, localSnapshots }, assertSnapshotIsolation },
      { timeout: 1000 },
    );
  await fs.writeFile(index, JSON.stringify({ fixture: { backup_file: external } }));
  const refusesExternal = async (variant) => {
    await assert.rejects(execute(variant), /fixture-snapshot-outside-profile/);
  };
  await assert.rejects(() => refusesExternal('before'), { name: 'AssertionError' });
  await refusesExternal('fixed');
  assert.equal(await execute('fixed', false), 'runtime-boundary');
  await fs.writeFile(
    index,
    JSON.stringify({ fixture: { backup_file: path.join(agent, 'backups/new.json') } }),
  );
  assert.equal(await execute('fixed'), 'runtime-boundary');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(agent, 'backups'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await refusesExternal('fixed');
  assert.equal(await fs.readFile(external, 'utf8'), 'original bytes');
});

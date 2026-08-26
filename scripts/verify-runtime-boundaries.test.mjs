import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyRuntimeBoundaries } from './verify-runtime-boundaries.mjs';

function runGit(rootDir, args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
}

async function writeFixtureFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

test('reports an indirect renderer dependency on a native database module', async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-runtime-boundaries-'));
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  runGit(rootDir, ['init']);
  runGit(rootDir, ['config', 'user.name', 'Agent Test']);
  runGit(rootDir, ['config', 'user.email', 'agent-test@example.com']);
  await writeFixtureFile(rootDir, 'src/renderer.ts', "import './bridge';\n");
  await writeFixtureFile(rootDir, 'src/bridge.ts', "export { db } from './native-db';\n");
  await writeFixtureFile(
    rootDir,
    'src/native-db.ts',
    "export const db = require('better-sqlite3');\n",
  );
  runGit(rootDir, ['add', '.']);
  runGit(rootDir, ['commit', '-m', 'fixture']);

  const report = verifyRuntimeBoundaries(rootDir);

  assert.deepEqual(report.violations, [
    {
      entry: 'src/renderer.ts',
      forbidden: 'better-sqlite3',
      rule: 'renderer-native-module',
      source: 'src/native-db.ts',
    },
  ]);
});

test('permits Electron in preload while retaining the preload boundary', async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-runtime-boundaries-'));
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  runGit(rootDir, ['init']);
  runGit(rootDir, ['config', 'user.name', 'Agent Test']);
  runGit(rootDir, ['config', 'user.email', 'agent-test@example.com']);
  await writeFixtureFile(rootDir, 'src/preload.ts', "import { contextBridge } from 'electron';\n");
  runGit(rootDir, ['add', '.']);
  runGit(rootDir, ['commit', '-m', 'fixture']);

  assert.deepEqual(verifyRuntimeBoundaries(rootDir).violations, []);
});

test('reports shared-to-feature and root-router-to-handler imports', async (context) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'agm-runtime-boundaries-'));
  context.after(async () => rm(rootDir, { recursive: true, force: true }));
  runGit(rootDir, ['init']);
  runGit(rootDir, ['config', 'user.name', 'Agent Test']);
  runGit(rootDir, ['config', 'user.email', 'agent-test@example.com']);
  await writeFixtureFile(
    rootDir,
    'src/ipc/router.ts',
    "import { handler } from '../modules/feature/ipc/handler';\nvoid handler;\n",
  );
  await writeFixtureFile(
    rootDir,
    'src/modules/feature/ipc/handler.ts',
    'export const handler = 1;\n',
  );
  await writeFixtureFile(
    rootDir,
    'src/shared/value.ts',
    "import { feature } from '../modules/feature/value';\nvoid feature;\n",
  );
  await writeFixtureFile(rootDir, 'src/modules/feature/value.ts', 'export const feature = 1;\n');
  runGit(rootDir, ['add', '.']);
  runGit(rootDir, ['commit', '-m', 'fixture']);

  assert.deepEqual(verifyRuntimeBoundaries(rootDir).violations, [
    {
      entry: 'src/ipc/router.ts',
      forbidden: 'src/modules/feature/ipc/handler.ts',
      rule: 'root-ipc-non-router-import',
      source: 'src/ipc/router.ts',
    },
    {
      entry: 'src/shared',
      forbidden: 'src/modules/feature/value.ts',
      rule: 'shared-feature-dependency',
      source: 'src/shared/value.ts',
    },
  ]);
});
